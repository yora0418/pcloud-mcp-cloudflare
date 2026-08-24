import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const TEAM_DOMAIN = "https://phase81-test.cloudflareaccess.com";
const POLICY_AUD = "mock-policy-audience";
const ACCESS_TOKEN = "mock-pcloud-access-token";
const ROOT_PATH = "/Scoped";
const CONTENT_HOST = "content.pcloud.com";
const CONTENT_PATH = "/temporary/mock-content";
const MCP_REQUEST_MAX_BYTES = 256 * 1024;
const PCLOUD_JSON_MAX_BYTES = 4 * 1024 * 1024;
const SEARCH_PCLOUD_JSON_MAX_BYTES = 16 * 1024 * 1024;
const SEARCH_DEFAULT_MAX_FOLDER_API_CALLS = 45;
const TOOL_INVOCATION_TIMEOUT_MS = 45_000;
const PCLOUD_PATH_MAX_BYTES = 16 * 1024;
const OUTBOUND_URL_MAX_BYTES = 16 * 1024;
const PCLOUD_FORM_BODY_MAX_BYTES = 64 * 1024;
const PCLOUD_ID_MAX_DECIMAL_DIGITS = 128;
const MCP_METADATA_RESULT_MAX_BYTES = 1024 * 1024;
const SEARCH_MAX_PENDING_FOLDERS = 2_048;
const SEARCH_MAX_PENDING_PATH_BYTES = 2 * 1024 * 1024;

let worker;
let bundleDirectory;
let accessJwt;
let accessPrivateKey;
let publicJwk;
let scenario;
let fetchCalls = [];
let contentCancelCount = 0;
let pCloudApiCancelCount = 0;
let rateLimitCalls = [];

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function streamingResponse(chunks, {
  headers = {},
  status = 200,
  onCancel,
  keepOpenOnExhaustion = false,
} = {}) {
  let chunkIndex = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (chunkIndex >= chunks.length) {
        if (!keepOpenOnExhaustion) {
          controller.close();
        }
        return;
      }
      controller.enqueue(chunks[chunkIndex]);
      chunkIndex += 1;
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status, headers });
}

function setScenario({
  virtualPath = "/Documents/note.md",
  rootPath = ROOT_PATH,
  metadata,
  bytes = new TextEncoder().encode("hello"),
  listMetadata,
  listMetadataByPath,
  contentLength,
  streamingChunks,
  keepOpenOnExhaustion = false,
  statResponseFactory,
  listResponseFactory,
  getfilelinkResponseFactory,
  contentStreamError,
} = {}) {
  const physicalPath =
    rootPath === "/" || virtualPath === "/"
      ? rootPath === "/"
        ? virtualPath
        : rootPath
      : `${rootPath}${virtualPath}`;
  const separatorIndex = physicalPath.lastIndexOf("/");
  const statParentPath =
    separatorIndex === 0 ? "/" : physicalPath.slice(0, separatorIndex);
  const identityDefaults =
    metadata?.isfolder === true
      ? { id: "d42", folderid: 42 }
      : { id: "f42", fileid: 42 };
  const baseMetadata =
    metadata === undefined
      ? {
          isfolder: false,
          name: virtualPath.slice(virtualPath.lastIndexOf("/") + 1),
          id: "f42",
          fileid: 42,
          size: bytes.byteLength,
          contenttype: "text/markdown",
        }
      : { ...identityDefaults, ...metadata };
  scenario = {
    virtualPath,
    rootPath,
    physicalPath,
    statParentPath,
    metadata: baseMetadata,
    bytes,
    listMetadata,
    listMetadataByPath,
    contentLength:
      contentLength === undefined ? String(bytes.byteLength) : contentLength,
    streamingChunks,
    keepOpenOnExhaustion,
    statResponseFactory,
    listResponseFactory,
    getfilelinkResponseFactory,
    contentStreamError,
  };
  fetchCalls = [];
  contentCancelCount = 0;
  pCloudApiCancelCount = 0;
  rateLimitCalls = [];
}

const allowRateLimiter = {
  async limit({ key }) {
    rateLimitCalls.push(key);
    return { success: true };
  },
};

async function makeAccessJwt(options = {}) {
  const sub = Object.hasOwn(options, "sub") ? options.sub : "mock-user";
  const {
    commonName,
    issuer = TEAM_DOMAIN,
    audience = POLICY_AUD,
    expiration = "5m",
    algorithm = "RS256",
  } = options;
  const payload = {};
  if (sub !== undefined) {
    payload.sub = sub;
  }
  if (commonName !== undefined) {
    payload.common_name = commonName;
  }

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: algorithm, kid: publicJwk.kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiration);

  if (algorithm === "HS256") {
    return jwt.sign(new TextEncoder().encode("not-an-rsa-key"));
  }
  return jwt.sign(accessPrivateKey);
}

function pCloudCallCount(pathname) {
  return fetchCalls.filter(
    ({ url }) => url.hostname.endsWith("pcloud.com") && url.pathname === pathname,
  ).length;
}

function parseToolText(result) {
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

function createRpcBody(method, params, targetLength) {
  rpcId += 1;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId,
    method,
    params,
  });
  if (targetLength === undefined) {
    return body;
  }
  assert.ok(body.length <= targetLength);
  return body.padEnd(targetLength, " ");
}

before(async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  bundleDirectory = await mkdtemp(path.join(tmpdir(), "pcloud-mcp-test-"));
  const wranglerEntrypoint = path.join(
    repositoryRoot,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  );
  execFileSync(
    process.execPath,
    [wranglerEntrypoint, "deploy", "--dry-run", "--outdir", bundleDirectory],
    { cwd: repositoryRoot, stdio: "pipe" },
  );

  const bundleName = (await readdir(bundleDirectory)).find((name) =>
    /\.(?:m?js)$/.test(name),
  );
  assert.ok(bundleName, "Wrangler dry-run did not produce a JavaScript bundle");
  worker = (await import(pathToFileURL(path.join(bundleDirectory, bundleName)).href))
    .default;
  assert.equal(typeof worker?.fetch, "function");

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  accessPrivateKey = privateKey;
  publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { alg: "RS256", use: "sig", kid: "mock-key" });
  accessJwt = await makeAccessJwt();

  globalThis.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const fetchCall = { request, url };
    fetchCalls.push(fetchCall);
    if (request.signal.aborted) {
      throw request.signal.reason;
    }

    if (
      url.origin === TEAM_DOMAIN &&
      url.pathname === "/cdn-cgi/access/certs"
    ) {
      return jsonResponse({ keys: [publicJwk] });
    }

    if (url.hostname === "api.pcloud.com" && url.pathname === "/stat") {
      assert.equal(request.method, "POST");
      assert.equal(url.search, "");
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
      assert.equal(
        request.headers.get("content-type"),
        "application/x-www-form-urlencoded",
      );
      const form = new URLSearchParams(await request.clone().text());
      fetchCall.form = form;
      assert.equal(
        form.get("path"),
        scenario.physicalPath,
      );
      if (scenario.statResponseFactory) {
        return scenario.statResponseFactory({ request, form, url });
      }
      return jsonResponse({ result: 0, metadata: scenario.metadata });
    }

    if (
      url.hostname === "api.pcloud.com" &&
      url.pathname === "/listfolder"
    ) {
      assert.equal(request.method, "POST");
      assert.equal(url.search, "");
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
      assert.equal(
        request.headers.get("content-type"),
        "application/x-www-form-urlencoded",
      );
      const form = new URLSearchParams(await request.clone().text());
      fetchCall.form = form;
      const requestedPath = form.get("path");
      const requestedFolderId = form.get("folderid");
      if (requestedFolderId === null) {
        assert.ok(
          requestedPath === scenario.rootPath ||
            requestedPath?.startsWith(`${scenario.rootPath}/`),
        );
      } else {
        assert.equal(requestedPath, null);
        assert.match(requestedFolderId, /^\d+$/);
      }
      assert.equal(form.get("recursive"), null);
      if (scenario.listResponseFactory) {
        return scenario.listResponseFactory({
          request,
          requestedPath,
          requestedFolderId,
          form,
          url,
        });
      }
      const metadata =
        scenario.listMetadataByPath?.[requestedPath] ??
        (requestedPath === scenario.rootPath || requestedFolderId !== null
          ? scenario.listMetadata
          : undefined) ??
        (requestedPath === scenario.statParentPath
          ? {
              isfolder: true,
              id: "d7",
              folderid: 7,
              contents: [scenario.metadata],
            }
          : undefined);
      const targetBoundMetadata =
        metadata && requestedPath !== null && !Object.hasOwn(metadata, "path")
          ? { ...metadata, path: requestedPath }
          : metadata &&
              requestedFolderId !== null &&
              !Object.hasOwn(metadata, "folderid")
            ? { ...metadata, folderid: requestedFolderId }
            : metadata;
      return jsonResponse({ result: 0, metadata: targetBoundMetadata });
    }

    if (
      url.hostname === "api.pcloud.com" &&
      url.pathname === "/getfilelink"
    ) {
      assert.equal(request.method, "POST");
      assert.equal(url.search, "");
      assert.equal(request.redirect, "manual");
      const form = new URLSearchParams(await request.text());
      fetchCall.form = form;
      assert.equal(
        form.get("path"),
        scenario.physicalPath,
      );
      assert.equal(form.get("access_token"), ACCESS_TOKEN);
      if (scenario.getfilelinkResponseFactory) {
        return scenario.getfilelinkResponseFactory();
      }
      return jsonResponse({ result: 0, hosts: [CONTENT_HOST], path: CONTENT_PATH });
    }

    if (url.hostname === CONTENT_HOST && url.pathname === CONTENT_PATH) {
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "manual");
      const headers = new Headers({ "content-type": "application/octet-stream" });
      if (scenario.contentLength !== null) {
        headers.set("content-length", scenario.contentLength);
      }
      if (!scenario.streamingChunks) {
        return new Response(scenario.bytes, { headers });
      }

      let chunkIndex = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (scenario.contentStreamError) {
            controller.error(scenario.contentStreamError);
            return;
          }
          if (chunkIndex >= scenario.streamingChunks.length) {
            if (!scenario.keepOpenOnExhaustion) {
              controller.close();
            }
            return;
          }
          controller.enqueue(scenario.streamingChunks[chunkIndex]);
          chunkIndex += 1;
        },
        cancel() {
          contentCancelCount += 1;
        },
      });
      return new Response(body, { headers });
    }

    throw new Error(`Unexpected mocked request to ${url.origin}${url.pathname}`);
  };

  setScenario();
});

after(async () => {
  if (bundleDirectory) {
    await rm(bundleDirectory, { recursive: true, force: true });
  }
});

const env = {
  TEAM_DOMAIN,
  POLICY_AUD,
  PCLOUD_ACCESS_TOKEN: ACCESS_TOKEN,
  PCLOUD_API_HOST: "api.pcloud.com",
  PCLOUD_ROOT_PATH: ROOT_PATH,
  MCP_RATE_LIMITER: allowRateLimiter,
};
const context = {
  waitUntil() {},
  passThroughOnException() {},
};
let rpcId = 0;

async function sendMcpRequest(body, {
  token = accessJwt,
  overrides = {},
  headers = {},
  signal,
} = {}) {
  const requestInit = {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Cf-Access-Jwt-Assertion": token,
      "MCP-Protocol-Version": "2025-11-25",
      ...headers,
    },
    body,
    signal,
  };
  if (body instanceof ReadableStream) {
    requestInit.duplex = "half";
  }

  return worker.fetch(
    new Request("https://worker.example/mcp", requestInit),
    { ...env, ...overrides },
    context,
  );
}

async function rpc(method, params, overrides = {}, token = accessJwt) {
  rpcId += 1;
  const response = await sendMcpRequest(
    JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
    { overrides, token },
  );
  return parseRpcHttpResponse(response);
}

async function parseRpcHttpResponse(response) {
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const payloads = responseText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()));
    assert.ok(payloads.length > 0);
    return payloads.at(-1);
  }
  return JSON.parse(responseText);
}

async function callTool(name, args, overrides = {}) {
  const response = await rpc(
    "tools/call",
    { name, arguments: args },
    overrides,
  );
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
}

test("valid RS256 Access JWT reaches the Worker and tools declare read-only hints", async () => {
  const hello = await callTool("hello", {});
  assert.match(hello.content[0].text, /is running/);

  const response = await rpc("tools/list", {});
  const tools = response.result.tools;
  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    [
      "get_file_info",
      "get_image_content",
      "get_office_content",
      "hello",
      "list_folder",
      "read_file",
      "search_files",
    ],
  );
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.openWorldHint, tool.name !== "hello");
  }
});

test("subscriptions/listen is disabled without affecting the seven tools", async () => {
  rpcId += 1;
  const response = await sendMcpRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "subscriptions/listen",
      params: {
        notifications: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    {
      headers: {
        "MCP-Protocol-Version": "2026-07-28",
        "MCP-Method": "subscriptions/listen",
      },
    },
  );
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  assert.doesNotMatch(
    response.headers.get("content-type") ?? "",
    /text\/event-stream/,
  );
  const payload = JSON.parse(responseText);
  assert.equal(payload.error.code, -32603);
  assert.equal(payload.error.message, "Subscription limit reached");

  const tools = (await rpc("tools/list", {})).result.tools;
  assert.equal(tools.length, 7);
  const hello = await callTool("hello", {});
  assert.match(hello.content[0].text, /is running/);
});

test("Access JWT verification rejects issuer, audience, algorithm, and expiry regressions", async () => {
  setScenario();
  const invalidTokens = [
    await makeAccessJwt({ issuer: "https://other.cloudflareaccess.com" }),
    await makeAccessJwt({ audience: "wrong-audience" }),
    await makeAccessJwt({ algorithm: "HS256" }),
    await makeAccessJwt({ expiration: Math.floor(Date.now() / 1000) - 60 }),
  ];

  for (const token of invalidTokens) {
    const response = await sendMcpRequest(
      createRpcBody("tools/list", {}),
      { token },
    );
    assert.equal(response.status, 403);
    assert.equal(await response.text(), "Forbidden");
  }
  assert.equal(rateLimitCalls.length, 0);
});

test("verified Access principals use sub, common_name, then a shared fallback", async () => {
  setScenario();
  const tokens = [
    await makeAccessJwt({ sub: "user-one" }),
    await makeAccessJwt({ sub: undefined, commonName: "service-one" }),
    await makeAccessJwt({ sub: undefined }),
  ];

  for (const token of tokens) {
    const response = await sendMcpRequest(
      createRpcBody("tools/list", {}),
      { token },
    );
    assert.equal(response.status, 200, await response.text());
  }
  assert.deepEqual(rateLimitCalls, [
    "sub:user-one",
    "common_name:service-one",
    "verified:shared",
  ]);
});

test("MCP POST rate limiting separates principals and fails closed if unavailable", async () => {
  setScenario();
  const counts = new Map();
  const limiter = {
    async limit({ key }) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= 2 };
    },
  };
  const firstToken = await makeAccessJwt({ sub: "rate-user-one" });
  const secondToken = await makeAccessJwt({ sub: "rate-user-two" });

  for (const expectedStatus of [200, 200, 429]) {
    const response = await sendMcpRequest(
      createRpcBody("tools/list", {}),
      { token: firstToken, overrides: { MCP_RATE_LIMITER: limiter } },
    );
    assert.equal(response.status, expectedStatus, await response.text());
  }
  const separatePrincipal = await sendMcpRequest(
    createRpcBody("tools/list", {}),
    { token: secondToken, overrides: { MCP_RATE_LIMITER: limiter } },
  );
  assert.equal(separatePrincipal.status, 200, await separatePrincipal.text());

  const throwingLimiter = {
    async limit() {
      throw new Error("mock binding failure");
    },
  };
  let response = await sendMcpRequest(createRpcBody("tools/list", {}), {
    overrides: { MCP_RATE_LIMITER: throwingLimiter },
  });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Service Unavailable");

  response = await sendMcpRequest(createRpcBody("tools/list", {}), {
    overrides: { MCP_RATE_LIMITER: undefined },
  });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Service Unavailable");
});

test("MCP ingress accepts bounded Content-Length and lengthless requests", async () => {
  setScenario();
  let body = createRpcBody("tools/list", {});
  let response = await sendMcpRequest(body, {
    headers: { "Content-Length": String(Buffer.byteLength(body)) },
  });
  assert.equal(response.status, 200, await response.text());

  body = createRpcBody("tools/list", {}, MCP_REQUEST_MAX_BYTES);
  response = await sendMcpRequest(body);
  assert.equal(response.status, 200, await response.text());

  const lengthlessBody = createRpcBody("tools/list", {});
  let sent = false;
  const lengthlessStream = new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(lengthlessBody));
      sent = true;
    },
  });
  response = await sendMcpRequest(lengthlessStream);
  assert.equal(response.status, 200, await response.text());
});

test("MCP ingress returns a generic deadline error for an incomplete body", async () => {
  const originalTimeout = AbortSignal.timeout;
  const privateTimeoutReason =
    "private timeout reason with https://temporary.example/physical/path";
  let cancelCount = 0;
  try {
    AbortSignal.timeout = (milliseconds) =>
      milliseconds > 40_000
        ? AbortSignal.abort(new Error(privateTimeoutReason))
        : new AbortController().signal;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelCount += 1;
      },
    });

    const response = await sendMcpRequest(body);
    const responseText = await response.text();
    assert.equal(response.status, 408);
    assert.equal(
      responseText,
      "MCP request was canceled or exceeded its deadline.",
    );
    assert.ok(!responseText.includes(privateTimeoutReason));
    assert.ok(!responseText.includes("temporary.example"));
    assert.equal(cancelCount, 1);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("authenticated bodyless GET and HEAD requests bypass POST-only guards", async () => {
  setScenario();
  let response = await worker.fetch(
    new Request("https://worker.example/", {
      method: "HEAD",
      headers: { "Cf-Access-Jwt-Assertion": accessJwt },
    }),
    { ...env, MCP_RATE_LIMITER: undefined },
    context,
  );
  assert.equal(response.status, 200);

  response = await worker.fetch(
    new Request("https://worker.example/mcp", {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Cf-Access-Jwt-Assertion": accessJwt,
        "MCP-Protocol-Version": "2025-11-25",
      },
    }),
    { ...env, MCP_RATE_LIMITER: undefined },
    context,
  );
  assert.notEqual(response.status, 503);
  assert.equal(rateLimitCalls.length, 0);
});

test("MCP ingress rejects malformed, declared oversized, and streamed oversized bodies", async () => {
  setScenario();
  let dispatchCancelCount = 0;
  const declaredBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() {
      dispatchCancelCount += 1;
    },
  });
  let response = await sendMcpRequest(declaredBody, {
    headers: { "Content-Length": String(MCP_REQUEST_MAX_BYTES + 1) },
  });
  assert.equal(response.status, 413);
  assert.equal(dispatchCancelCount, 1);
  assert.match(await response.text(), /262144-byte limit/);

  response = await sendMcpRequest("{}", {
    headers: { "Content-Length": "01" },
  });
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid Content-Length header.");

  dispatchCancelCount = 0;
  let chunkIndex = 0;
  const chunks = [
    new Uint8Array(MCP_REQUEST_MAX_BYTES),
    new Uint8Array([1]),
  ];
  const oversizedStream = new ReadableStream({
    pull(controller) {
      controller.enqueue(chunks[chunkIndex]);
      chunkIndex += 1;
    },
    cancel() {
      dispatchCancelCount += 1;
    },
  });
  response = await sendMcpRequest(oversizedStream);
  assert.equal(response.status, 413);
  assert.equal(dispatchCancelCount, 1);
  assert.match(await response.text(), /262144-byte limit/);
});

test("metadata tools never expose rounded 64-bit identifiers or sizes", async () => {
  setScenario({
    listMetadata: {
      isfolder: true,
      name: "Scoped",
      id: "d9007199254740993",
      folderid: Number.MAX_SAFE_INTEGER + 1,
      contents: [
        {
          isfolder: true,
          name: "Folder",
          id: "d9007199254740995",
          folderid: Number.MAX_SAFE_INTEGER + 1,
        },
        {
          isfolder: false,
          name: "unsafe.bin",
          id: "f9007199254740997",
          fileid: Number.MAX_SAFE_INTEGER + 1,
          size: Number.MAX_SAFE_INTEGER + 1,
        },
        {
          isfolder: false,
          name: "exact.bin",
          fileid: "9007199254740999",
          size: "9007199254741001",
        },
      ],
    },
  });
  const listing = parseToolText(await callTool("list_folder", { path: "/" }));
  assert.equal(listing.folder.folderId, "9007199254740993");
  assert.equal(listing.entries[0].folderId, "9007199254740995");
  assert.equal(listing.entries[1].fileId, "9007199254740997");
  assert.equal("size" in listing.entries[1], false);
  assert.equal(listing.entries[2].fileId, "9007199254740999");
  assert.equal(listing.entries[2].size, "9007199254741001");

  setScenario({
    virtualPath: "/Documents/unsafe.bin",
    metadata: {
      isfolder: false,
      name: "unsafe.bin",
      id: "f9007199254740993",
      fileid: Number.MAX_SAFE_INTEGER + 1,
      size: Number.MAX_SAFE_INTEGER + 1,
      hash: Number.MAX_SAFE_INTEGER + 1,
    },
  });
  const info = parseToolText(
    await callTool("get_file_info", { path: scenario.virtualPath }),
  );
  assert.equal(info.fileId, "9007199254740993");
  assert.equal("size" in info, false);
  assert.equal("hash" in info, false);
});

test("legacy JSON-RPC batches are rejected before SDK or pCloud dispatch", async () => {
  setScenario();
  const response = await sendMcpRequest(
    JSON.stringify([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_file_info", arguments: { path: "/secret" } },
      },
    ]),
  );
  assert.equal(response.status, 400);
  assert.equal(
    await response.text(),
    "JSON-RPC batch requests are not supported.",
  );
  assert.equal(pCloudCallCount("/stat"), 0);
  assert.equal(pCloudCallCount("/listfolder"), 0);

  const tools = (await rpc("tools/list", {})).result.tools;
  assert.equal(tools.length, 7);
});

test("pCloud JSON calls require an explicit canonical result code", async () => {
  const metadata = {
    isfolder: false,
    name: "note.md",
    size: 5,
    contenttype: "text/markdown",
  };
  const invalidResponses = [
    { metadata },
    { result: null, metadata },
    { result: true, metadata },
    { result: "00", metadata },
    { result: -1, metadata },
    { result: Number.MAX_SAFE_INTEGER + 1, metadata },
  ];

  for (const responseBody of invalidResponses) {
    setScenario({
      statResponseFactory: () => jsonResponse(responseBody),
    });
    const result = await callTool("get_file_info", {
      path: scenario.virtualPath,
    });
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      "pCloud returned an invalid result code.",
    );
    assert.equal(pCloudCallCount("/stat"), 1);
  }
});

test("folder listings fail closed on malformed metadata or entries", async () => {
  const invalidFolderMetadata = [
    undefined,
    {},
    { isfolder: false, contents: [] },
    { isfolder: true },
    { isfolder: true, contents: {} },
  ];

  for (const metadata of invalidFolderMetadata) {
    setScenario({
      listResponseFactory: ({ requestedPath }) =>
        jsonResponse({
          result: 0,
          metadata:
            metadata && typeof metadata === "object" && !Array.isArray(metadata)
              ? { ...metadata, path: requestedPath }
              : metadata,
        }),
    });
    const result = await callTool("list_folder", { path: "/" });
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /pCloud listfolder (?:response did not identify its target|returned invalid folder metadata)/,
    );
  }

  const invalidEntries = [
    null,
    { isfolder: "false", name: "file.txt" },
    { isfolder: false },
    { isfolder: false, name: ".." },
    { isfolder: false, name: "bad/name.txt" },
    { isfolder: false, name: "bad\\name.txt" },
    { isfolder: false, name: "bad\u0001name.txt" },
    { isfolder: false, name: "bad\u0085name.txt" },
  ];

  for (const invalidEntry of invalidEntries) {
    setScenario({
      listMetadata: {
        isfolder: true,
        contents: [
          { isfolder: false, name: "valid.txt", size: 1 },
          invalidEntry,
        ],
      },
    });
    const listResult = await callTool("list_folder", {
      path: "/",
      maxEntries: 1,
    });
    assert.equal(listResult.isError, true);
    assert.ok(!JSON.stringify(listResult).includes("valid.txt"));

    const searchResult = await callTool("search_files", {
      query: "valid",
      path: "/",
    });
    assert.equal(searchResult.isError, true);
    assert.ok(!JSON.stringify(searchResult).includes("valid.txt"));
  }
});

test("pCloud metadata responses are bound to exact path-derived identity", async () => {
  setScenario({
    statResponseFactory: () =>
      jsonResponse({
        result: 0,
        metadata: { ...scenario.metadata, path: "/different/target" },
      }),
  });
  let info = parseToolText(
    await callTool("get_file_info", { path: scenario.virtualPath }),
  );
  assert.equal(info.path, scenario.virtualPath);
  assert.equal(info.fileId, "42");
  assert.equal(pCloudCallCount("/stat"), 1);
  assert.equal(pCloudCallCount("/listfolder"), 1);

  setScenario({
    metadata: {
      isfolder: false,
      name: "note.md",
      path: `${ROOT_PATH}/Documents/note.md`,
      size: 5,
      contenttype: "text/markdown",
    },
  });
  info = parseToolText(
    await callTool("get_file_info", { path: scenario.virtualPath }),
  );
  assert.equal(info.path, scenario.virtualPath);
  assert.equal(pCloudCallCount("/stat"), 1);
  assert.equal(pCloudCallCount("/listfolder"), 0);

  setScenario({
    statResponseFactory: () =>
      jsonResponse({
        result: 0,
        metadata: {
          ...scenario.metadata,
          id: "f43",
          fileid: 43,
          path: "/different/target",
        },
      }),
  });
  let result = await callTool("get_file_info", { path: scenario.virtualPath });
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "pCloud stat response did not match the requested target.",
  );
  assert.equal(pCloudCallCount("/listfolder"), 1);

  setScenario({
    statResponseFactory: () =>
      jsonResponse({
        result: 0,
        metadata: {
          ...scenario.metadata,
          name: "different-name.md",
          path: scenario.physicalPath,
        },
      }),
  });
  result = await callTool("get_file_info", { path: scenario.virtualPath });
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "pCloud stat response did not match the requested target.",
  );
  assert.equal(pCloudCallCount("/listfolder"), 0);

  setScenario({
    listResponseFactory: () =>
      jsonResponse({
        result: 0,
        metadata: {
          isfolder: true,
          path: "/different/target",
          contents: [],
        },
      }),
  });
  result = await callTool("list_folder", { path: "/" });
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "pCloud listfolder response did not match the requested target.",
  );

  setScenario({
    rootPath: "/",
    listMetadata: {
      isfolder: true,
      folderid: "124",
      contents: [],
    },
  });
  result = await callTool(
    "list_folder",
    { folderId: "123" },
    { PCLOUD_ROOT_PATH: "/" },
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "pCloud listfolder response did not match the requested target.",
  );
});

test("folder listing paths come only from validated virtual parents", async () => {
  setScenario({
    listMetadata: {
      isfolder: true,
      name: "Scoped",
      path: ROOT_PATH,
      contents: [
        {
          isfolder: false,
          name: " report.txt ",
          path: "/private/physical/root/report.txt",
          size: 1,
        },
      ],
    },
  });
  let listing = parseToolText(await callTool("list_folder", { path: "/" }));
  assert.equal(listing.folder.path, "/");
  assert.equal(listing.entries[0].name, " report.txt ");
  assert.equal(listing.entries[0].path, "/ report.txt ");
  assert.ok(!JSON.stringify(listing).includes("/private/physical/root"));
  assert.ok(!JSON.stringify(listing).includes(ROOT_PATH));

  setScenario({
    rootPath: "/",
    listMetadata: {
      isfolder: true,
      name: "Folder by ID",
      folderid: "123",
      path: "/private/physical/root",
      contents: [
        {
          isfolder: false,
          name: "entry.txt",
          path: "/private/physical/root/entry.txt",
          size: 1,
        },
      ],
    },
  });
  listing = parseToolText(
    await callTool(
      "list_folder",
      { folderId: "123" },
      { PCLOUD_ROOT_PATH: "/" },
    ),
  );
  assert.equal("path" in listing.folder, false);
  assert.equal("path" in listing.entries[0], false);
  assert.ok(!JSON.stringify(listing).includes("/private/physical/root"));
});

test("virtual paths preserve spaces exactly and reject unsupported inputs", async () => {
  setScenario({
    rootPath: "/Scoped ",
    virtualPath: "/Documents/report.md ",
    metadata: {
      isfolder: false,
      name: "report.md ",
      size: 5,
      contenttype: "text/markdown",
    },
  });
  const info = parseToolText(
    await callTool(
      "get_file_info",
      { path: scenario.virtualPath },
      { PCLOUD_ROOT_PATH: scenario.rootPath },
    ),
  );
  assert.equal(info.path, "/Documents/report.md ");
  const statRequest = fetchCalls.find(({ url }) => url.pathname === "/stat");
  assert.equal(
    statRequest.form.get("path"),
    "/Scoped /Documents/report.md ",
  );

  const textBytes = new TextEncoder().encode("hello");
  setScenario({
    virtualPath: "/ Text / note.md ",
    bytes: textBytes,
    metadata: {
      isfolder: false,
      name: " note.md ",
      size: textBytes.byteLength,
      contenttype: "text/markdown",
    },
  });
  const text = parseToolText(
    await callTool("read_file", {
      path: scenario.virtualPath,
      maxBytes: textBytes.byteLength,
    }),
  );
  assert.equal(text.path, "/ Text / note.md ");
  assert.equal(text.content, "hello");
  const readStatRequest = fetchCalls.find(({ url }) => url.pathname === "/stat");
  assert.equal(
    readStatRequest.form.get("path"),
    `${ROOT_PATH}/ Text / note.md `,
  );

  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  setScenario({
    virtualPath: "/ Images /sample.png ",
    bytes: png,
    metadata: {
      isfolder: false,
      name: "sample.png ",
      size: png.byteLength,
      contenttype: "image/png",
    },
  });
  const image = await callTool("get_image_content", {
    path: scenario.virtualPath,
  });
  assert.equal(image.content[0].type, "image");
  const imageStatRequest = fetchCalls.find(
    ({ url }) => url.pathname === "/stat",
  );
  assert.equal(
    imageStatRequest.form.get("path"),
    `${ROOT_PATH}/ Images /sample.png `,
  );
  assert.equal(pCloudCallCount("/getfilelink"), 1);

  const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
  setScenario({
    virtualPath: "/ Office /sample.docx ",
    bytes: docx,
    metadata: {
      isfolder: false,
      name: "sample.docx ",
      size: docx.byteLength,
      contenttype:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  });
  const office = await callTool("get_office_content", {
    path: scenario.virtualPath,
  });
  assert.equal(office.isError, true);
  assert.equal(
    office.content[0].text,
    'File at virtual path "/ Office /sample.docx " is not a supported DOCX, XLSX, or PPTX file.',
  );
  const officeStatRequest = fetchCalls.find(
    ({ url }) => url.pathname === "/stat",
  );
  assert.equal(
    officeStatRequest.form.get("path"),
    `${ROOT_PATH}/ Office /sample.docx `,
  );
  assert.equal(pCloudCallCount("/getfilelink"), 0);

  setScenario({
    listMetadataByPath: {
      [`${ROOT_PATH}/ Folder `]: {
        isfolder: true,
        contents: [{ isfolder: false, name: " report.txt ", size: 1 }],
      },
    },
  });
  const search = parseToolText(
    await callTool("search_files", {
      query: "report",
      path: "/ Folder ",
    }),
  );
  assert.equal(search.searchPath, "/ Folder ");
  assert.equal(search.matches[0].name, " report.txt ");
  assert.equal(search.matches[0].path, "/ Folder / report.txt ");

  const unsupportedPaths = [
    "",
    "   ",
    "/Documents/../outside.txt",
    "/Documents/./file.txt",
    "/Documents/bad\\name.txt",
    "/Documents/bad\u0001name.txt",
    "/Documents/bad\u0085name.txt",
  ];
  for (const pathValue of unsupportedPaths) {
    setScenario();
    const result = await callTool("get_file_info", { path: pathValue });
    assert.equal(result.isError, true);
    assert.equal(pCloudCallCount("/stat"), 0);
  }
});

test("virtual path segments enforce the 1024-byte UTF-8 boundary", async () => {
  const multibyteAccepted = `${"\u00e9".repeat(511)}a`;
  const multibyteRejected = "\u00e9".repeat(512);
  assert.equal(multibyteAccepted.length, 512);
  assert.equal(multibyteRejected.length, 512);
  assert.equal(new TextEncoder().encode(multibyteAccepted).byteLength, 1023);
  assert.equal(new TextEncoder().encode(multibyteRejected).byteLength, 1024);

  for (const segment of ["a".repeat(1023), multibyteAccepted]) {
    assert.equal(new TextEncoder().encode(segment).byteLength, 1023);
    const virtualPath = `/${segment}`;
    setScenario({ virtualPath });
    const info = parseToolText(
      await callTool("get_file_info", { path: virtualPath }),
    );
    assert.equal(info.path, virtualPath);
    assert.equal(pCloudCallCount("/stat"), 1);
  }

  for (const segment of ["a".repeat(1024), multibyteRejected]) {
    assert.equal(new TextEncoder().encode(segment).byteLength, 1024);
    setScenario();
    const result = await callTool("get_file_info", { path: `/${segment}` });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /path segment that is too long/);
    assert.equal(pCloudCallCount("/stat"), 0);
  }
});

test("unpaired surrogates fail closed across exact pCloud path boundaries", async () => {
  for (const virtualPath of ["/\uD800", "/\uDC00", "/\uD800a", "/a\uDC00"]) {
    setScenario();
    const result = await callTool("get_file_info", { path: virtualPath });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unsupported Unicode sequence/);
    assert.equal(pCloudCallCount("/stat"), 0);
  }

  setScenario({ virtualPath: "/valid.txt" });
  const invalidRoot = await callTool(
    "get_file_info",
    { path: scenario.virtualPath },
    { PCLOUD_ROOT_PATH: "/Scoped\uD800" },
  );
  assert.equal(invalidRoot.isError, true);
  assert.match(invalidRoot.content[0].text, /unsupported Unicode sequence/);
  assert.equal(pCloudCallCount("/stat"), 0);

  for (const name of ["folder\uD800", "folder\uDC00"]) {
    setScenario({
      listMetadata: {
        isfolder: true,
        contents: [{ isfolder: true, name }],
      },
    });
    const result = await callTool("search_files", {
      query: "folder",
      path: "/",
    });
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      "pCloud listfolder returned an invalid entry name.",
    );
    assert.equal(pCloudCallCount("/listfolder"), 1);
  }

  for (const contentPath of ["/temporary/\uD800", "/temporary/\uDC00"]) {
    const bytes = new TextEncoder().encode("hello");
    setScenario({
      bytes,
      getfilelinkResponseFactory: () =>
        jsonResponse({ result: 0, hosts: [CONTENT_HOST], path: contentPath }),
    });
    const result = await callTool("read_file", {
      path: scenario.virtualPath,
      maxBytes: bytes.byteLength,
    });
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      "pCloud getfilelink returned an invalid response.",
    );
    assert.equal(pCloudCallCount("/getfilelink"), 1);
    assert.equal(
      fetchCalls.filter(({ url }) => url.hostname === CONTENT_HOST).length,
      0,
    );
  }

  setScenario({
    getfilelinkResponseFactory: () =>
      jsonResponse({
        result: 0,
        hosts: [`content\uD800.pcloud.com`],
        path: CONTENT_PATH,
      }),
  });
  const invalidContentHost = await callTool("read_file", {
    path: scenario.virtualPath,
    maxBytes: scenario.bytes.byteLength,
  });
  assert.equal(invalidContentHost.isError, true);
  assert.equal(
    invalidContentHost.content[0].text,
    "pCloud getfilelink returned an invalid response.",
  );
  assert.equal(pCloudCallCount("/getfilelink"), 1);
  assert.equal(
    fetchCalls.filter(({ url }) => url.hostname.endsWith("pcloud.com")).length,
    3,
  );

  const pairedPath = "/\uD83D\uDE00";
  setScenario({ virtualPath: pairedPath });
  const pairedResult = parseToolText(
    await callTool("get_file_info", { path: pairedPath }),
  );
  assert.equal(pairedResult.path, pairedPath);
  const statRequest = fetchCalls.find(({ url }) => url.pathname === "/stat");
  assert.equal(
    statRequest.form.get("path"),
    `${ROOT_PATH}${pairedPath}`,
  );
  assert.equal(pCloudCallCount("/stat"), 1);
  assert.equal(pCloudCallCount("/listfolder"), 1);
});

test("listfolder entry names enforce the 1024-byte UTF-8 boundary", async () => {
  const multibyteAccepted = `${"\u00e9".repeat(511)}a`;
  const multibyteRejected = "\u00e9".repeat(512);

  for (const name of ["a".repeat(1023), multibyteAccepted]) {
    assert.equal(new TextEncoder().encode(name).byteLength, 1023);
    setScenario({
      listMetadata: {
        isfolder: true,
        contents: [{ isfolder: false, name, size: 1 }],
      },
    });
    const listing = parseToolText(
      await callTool("list_folder", { path: "/" }),
    );
    assert.equal(listing.entries[0].name, name);
    assert.equal(listing.entries[0].path, `/${name}`);
  }

  for (const name of ["a".repeat(1024), multibyteRejected]) {
    assert.equal(new TextEncoder().encode(name).byteLength, 1024);
    setScenario({
      listMetadata: {
        isfolder: true,
        contents: [{ isfolder: false, name, size: 1 }],
      },
    });
    const result = await callTool("list_folder", { path: "/" });
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      "pCloud listfolder returned an invalid entry name.",
    );
  }
});

test("Bearer-authenticated pCloud API redirects fail closed without a second fetch", async () => {
  setScenario({
    virtualPath: "/Documents/note.md",
    statResponseFactory: () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://hostile.example/collect" },
      }),
  });
  const result = await callTool("get_file_info", {
    path: scenario.virtualPath,
  });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "pCloud HTTP error 302.");
  assert.equal(pCloudCallCount("/stat"), 1);
  assert.equal(
    fetchCalls.filter(({ url }) => url.hostname === "hostile.example").length,
    0,
  );
  const statRequest = fetchCalls.find(({ url }) => url.pathname === "/stat");
  assert.equal(statRequest.request.redirect, "manual");
  assert.equal(
    statRequest.request.headers.get("authorization"),
    `Bearer ${ACCESS_TOKEN}`,
  );
  assert.ok(!JSON.stringify(result).includes("hostile.example"));
  assert.ok(!JSON.stringify(result).includes(ACCESS_TOKEN));
});

test("pCloud JSON responses are bounded by declared and streamed byte counts", async () => {
  setScenario({
    statResponseFactory: () =>
      streamingResponse([], {
        headers: {
          "content-type": "application/json",
          "content-length": String(PCLOUD_JSON_MAX_BYTES + 1),
        },
        onCancel() {
          pCloudApiCancelCount += 1;
        },
        keepOpenOnExhaustion: true,
      }),
  });
  let result = await callTool("get_file_info", { path: scenario.virtualPath });
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    `pCloud JSON response exceeded the ${PCLOUD_JSON_MAX_BYTES}-byte safety limit.`,
  );
  assert.equal(pCloudApiCancelCount, 1);

  setScenario({
    statResponseFactory: () =>
      streamingResponse(
        [new Uint8Array(PCLOUD_JSON_MAX_BYTES), new Uint8Array([1])],
        {
          headers: { "content-type": "application/json" },
          onCancel() {
            pCloudApiCancelCount += 1;
          },
          keepOpenOnExhaustion: true,
        },
      ),
  });
  result = await callTool("get_file_info", { path: scenario.virtualPath });
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    `pCloud JSON response exceeded the ${PCLOUD_JSON_MAX_BYTES}-byte safety limit.`,
  );
  assert.equal(pCloudApiCancelCount, 1);

  setScenario({
    statResponseFactory: () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
  });
  result = await callTool("get_file_info", { path: scenario.virtualPath });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "pCloud returned an invalid JSON response.");
});

test("getfilelink JSON uses its own bounded response limit", async () => {
  const bytes = new TextEncoder().encode("hello");
  setScenario({
    bytes,
    getfilelinkResponseFactory: () =>
      streamingResponse([], {
        headers: {
          "content-type": "application/json",
          "content-length": String(64 * 1024 + 1),
        },
        onCancel() {
          pCloudApiCancelCount += 1;
        },
        keepOpenOnExhaustion: true,
      }),
  });
  const result = await callTool("read_file", {
    path: scenario.virtualPath,
    maxBytes: bytes.byteLength,
  });
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "pCloud getfilelink JSON response exceeded the 65536-byte safety limit.",
  );
  assert.equal(pCloudApiCancelCount, 1);
  assert.equal(pCloudCallCount(CONTENT_PATH), 0);
});

test("search uses non-recursive folder listings and completes traversal after maxResults", async () => {
  setScenario({
    listMetadataByPath: {
      [ROOT_PATH]: {
        isfolder: true,
        contents: [
          {
            isfolder: true,
            name: "Folder",
            folderid: Number.MAX_SAFE_INTEGER + 1,
          },
          { isfolder: false, name: "root-match.txt", size: 1 },
          { isfolder: false, name: "other.txt", size: 1 },
        ],
      },
      [`${ROOT_PATH}/Folder`]: {
        isfolder: true,
        contents: [
          { isfolder: false, name: "nested-match.txt", size: 1 },
          { isfolder: false, name: "third-match.txt", size: 1 },
        ],
      },
    },
  });

  const result = parseToolText(
    await callTool("search_files", {
      query: "match",
      path: "/",
      maxResults: 1,
      includeFolders: true,
    }),
  );
  assert.equal(result.scannedEntries, 5);
  assert.equal(result.folderApiCalls, 2);
  assert.equal(result.totalMatches, 3);
  assert.equal(result.returnedMatches, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.matches[0].path, "/root-match.txt");
  assert.deepEqual(result.safetyLimits, {
    maxScannedEntries: 10_000,
    maxDepth: 64,
    maxFolderApiCalls: SEARCH_DEFAULT_MAX_FOLDER_API_CALLS,
    maxPCloudJsonBytes: SEARCH_PCLOUD_JSON_MAX_BYTES,
    maxPathBytes: PCLOUD_PATH_MAX_BYTES,
    maxPendingFolders: SEARCH_MAX_PENDING_FOLDERS,
    maxPendingPathBytes: SEARCH_MAX_PENDING_PATH_BYTES,
    maxResultBytes: MCP_METADATA_RESULT_MAX_BYTES,
  });
  assert.equal(
    fetchCalls
      .filter(({ url }) => url.pathname === "/listfolder")
      .some(({ form }) => form?.has("recursive")),
    false,
  );
  assert.equal(
    fetchCalls
      .filter(({ url }) => url.pathname === "/listfolder")
      .some(({ form }) => form?.has("folderid")),
    false,
  );

  const nestedResult = parseToolText(
    await callTool("search_files", {
      query: "nested",
      path: "/",
      includeFolders: false,
    }),
  );
  assert.equal(nestedResult.matches[0].path, "/Folder/nested-match.txt");

  const scopedSearchResult = parseToolText(
    await callTool("search_files", {
      query: "nested",
      path: "/Folder",
      includeFolders: false,
    }),
  );
  assert.equal(scopedSearchResult.searchPath, "/Folder");
  assert.equal(
    scopedSearchResult.matches[0].path,
    "/Folder/nested-match.txt",
  );
});

test("search preserves exact query identity and matches names and paths separately", async () => {
  setScenario({
    listMetadata: {
      isfolder: true,
      contents: [
        { isfolder: false, name: "foo", size: 1 },
        { isfolder: false, name: "foo ", size: 1 },
      ],
    },
  });
  let result = parseToolText(
    await callTool("search_files", { query: "foo ", path: "/" }),
  );
  assert.equal(result.query, "foo ");
  assert.equal(result.totalMatches, 1);
  assert.equal(result.matches[0].name, "foo ");

  setScenario({
    listMetadata: {
      isfolder: true,
      contents: [
        { isfolder: false, name: " Leading and trailing ", size: 1 },
      ],
    },
  });
  result = parseToolText(
    await callTool("search_files", {
      query: " leading and trailing ",
      path: "/",
    }),
  );
  assert.equal(result.query, " leading and trailing ");
  assert.equal(result.totalMatches, 1);
  assert.equal(result.matches[0].name, " Leading and trailing ");

  setScenario({
    listMetadata: {
      isfolder: true,
      contents: [{ isfolder: false, name: "foo", size: 1 }],
    },
  });
  let errorResult = await callTool("search_files", {
    query: "foo\n/foo",
    path: "/",
  });
  assert.equal(errorResult.isError, true);
  assert.equal(
    errorResult.content[0].text,
    "query contains an unsupported control character.",
  );
  assert.equal(pCloudCallCount("/listfolder"), 0);

  for (const query of ["   ", "\uD800"]) {
    setScenario();
    errorResult = await callTool("search_files", { query, path: "/" });
    assert.equal(errorResult.isError, true);
    assert.equal(pCloudCallCount("/listfolder"), 0);
  }

  setScenario({
    listMetadata: {
      isfolder: true,
      contents: [{ isfolder: false, name: "CaseName.TXT", size: 1 }],
    },
  });
  result = parseToolText(
    await callTool("search_files", { query: "casename.txt", path: "/" }),
  );
  assert.equal(result.query, "casename.txt");
  assert.equal(result.totalMatches, 1);
  assert.equal(result.matches[0].name, "CaseName.TXT");
});

test("search rejects scanned-entry and depth overflow without partial results", async () => {
  setScenario({
    listMetadata: {
      isfolder: true,
      contents: [
        ...Array.from({ length: 10_000 }, (_, index) => ({
          isfolder: false,
          name: `entry-${index}.txt`,
          size: 1,
        })),
        { isfolder: false, name: "invalid/entry" },
      ],
    },
  });
  let errorResult = await callTool("search_files", {
    query: "entry",
    path: "/",
  });
  assert.equal(errorResult.isError, true);
  assert.match(errorResult.content[0].text, /10000-entry safety limit/);
  assert.match(errorResult.content[0].text, /no complete search result/);

  const listMetadataByPath = {};
  let parentPath = ROOT_PATH;
  for (let depth = 1; depth <= 65; depth += 1) {
    const name = `level-${depth}`;
    listMetadataByPath[parentPath] = {
      isfolder: true,
      contents: [{ isfolder: true, name }],
    };
    parentPath = `${parentPath}/${name}`;
  }
  setScenario({ listMetadataByPath });
  errorResult = await callTool(
    "search_files",
    {
      query: "level",
      path: "/",
    },
    { PCLOUD_SEARCH_MAX_FOLDER_CALLS: "1024" },
  );
  assert.equal(errorResult.isError, true);
  assert.match(errorResult.content[0].text, /64-level nesting safety limit/);
  assert.match(errorResult.content[0].text, /no complete search result/);
  assert.equal(pCloudCallCount("/listfolder"), 65);
});

test("pCloud metadata, getfilelink, and content requests have application timeouts", async () => {
  const originalTimeout = AbortSignal.timeout;
  const nonAbortingSignal = () => new AbortController().signal;
  try {
    AbortSignal.timeout = (milliseconds) =>
      milliseconds === 10_000
        ? AbortSignal.abort(new DOMException("timeout", "TimeoutError"))
        : nonAbortingSignal();
    setScenario();
    let result = await callTool("get_file_info", { path: scenario.virtualPath });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "pCloud metadata request timed out.");
    assert.equal(pCloudCallCount("/stat"), 1);

    let tenSecondSignals = 0;
    AbortSignal.timeout = (milliseconds) => {
      if (milliseconds === 10_000) {
        tenSecondSignals += 1;
        return tenSecondSignals === 1
          ? nonAbortingSignal()
          : AbortSignal.abort(new DOMException("timeout", "TimeoutError"));
      }
      return nonAbortingSignal();
    };
    setScenario();
    scenario.metadata.path = scenario.physicalPath;
    result = await callTool("read_file", { path: scenario.virtualPath });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "pCloud getfilelink request timed out.");
    assert.equal(pCloudCallCount("/getfilelink"), 1);

    AbortSignal.timeout = (milliseconds) =>
      milliseconds === 30_000
        ? AbortSignal.abort(new DOMException("timeout", "TimeoutError"))
        : nonAbortingSignal();
    setScenario();
    scenario.metadata.path = scenario.physicalPath;
    result = await callTool("read_file", { path: scenario.virtualPath });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "pCloud content request timed out.");
    assert.equal(
      fetchCalls.filter(({ url }) => url.hostname === CONTENT_HOST).length,
      1,
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("search uses the shorter remaining overall deadline for each folder fetch", async () => {
  const originalNow = Date.now;
  const originalTimeout = AbortSignal.timeout;
  const timeoutDurations = [];
  let now = originalNow();
  try {
    Date.now = () => now;
    AbortSignal.timeout = (milliseconds) => {
      timeoutDurations.push(milliseconds);
      return new AbortController().signal;
    };
    let listCall = 0;
    setScenario({
      listResponseFactory: ({ requestedPath }) => {
        listCall += 1;
        if (listCall === 1) {
          now += TOOL_INVOCATION_TIMEOUT_MS - 5_000;
          return jsonResponse({
            result: 0,
            metadata: {
              path: requestedPath,
              isfolder: true,
              contents: [{ isfolder: true, name: "Folder" }],
            },
          });
        }
        return jsonResponse({
          result: 0,
          metadata: {
            path: requestedPath,
            isfolder: true,
            contents: [],
          },
        });
      },
    });

    const result = parseToolText(
      await callTool("search_files", { query: "absent", path: "/" }),
    );
    assert.equal(result.folderApiCalls, 2);
    assert.deepEqual(timeoutDurations.slice(-2), [10_000, 5_000]);
  } finally {
    Date.now = originalNow;
    AbortSignal.timeout = originalTimeout;
  }
});

test("search stops before another pCloud call after its overall deadline", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    setScenario({
      listResponseFactory: ({ requestedPath }) => {
        now += TOOL_INVOCATION_TIMEOUT_MS;
        return jsonResponse({
          result: 0,
          metadata: {
            path: requestedPath,
            isfolder: true,
            contents: [{ isfolder: true, name: "Folder" }],
          },
        });
      },
    });

    const result = await callTool("search_files", {
      query: "folder",
      path: "/",
    });
    assert.equal(result.isError, true);
    assert.equal(
      result.content[0].text,
      "pCloud operation was canceled or exceeded its deadline.",
    );
    assert.equal(pCloudCallCount("/listfolder"), 1);
  } finally {
    Date.now = originalNow;
  }
});

test("search propagates client abort without exposing its reason or starting another call", async () => {
  const controller = new AbortController();
  const privateAbortReason =
    "private abort reason with https://temporary.example/physical/path";
  setScenario({
    listResponseFactory: ({ requestedPath }) => {
      controller.abort(new Error(privateAbortReason));
      return jsonResponse({
        result: 0,
        metadata: {
          path: requestedPath,
          isfolder: true,
          contents: [{ isfolder: true, name: "Folder" }],
        },
      });
    },
  });

  const response = await sendMcpRequest(
    createRpcBody("tools/call", {
      name: "search_files",
      arguments: { query: "folder", path: "/" },
    }),
    { signal: controller.signal },
  );
  const responseText = await response.text();
  assert.ok(!responseText.includes(privateAbortReason));
  assert.ok(!responseText.includes("temporary.example"));
  assert.equal(pCloudCallCount("/listfolder"), 1);
});

test("outbound pCloud requests bound encoded forms, IDs, and content URLs", async () => {
  const multibyteSegment = "あ".repeat(333);
  const multibytePath = `/${Array.from({ length: 16 }, () => multibyteSegment).join("/")}`;
  setScenario({
    virtualPath: multibytePath,
    metadata: {
      isfolder: false,
      name: multibyteSegment,
      path: `${ROOT_PATH}${multibytePath}`,
      fileid: "42",
      size: 1,
      contenttype: "text/plain",
    },
  });
  let result = await callTool("get_file_info", { path: multibytePath });
  assert.equal(result.isError, undefined);
  const statCall = fetchCalls.find(({ url }) => url.pathname === "/stat");
  assert.ok(statCall);
  assert.equal(statCall.request.method, "POST");
  assert.equal(statCall.url.search, "");
  assert.equal(statCall.form.get("path"), `${ROOT_PATH}${multibytePath}`);
  assert.ok(new TextEncoder().encode(statCall.url.href).byteLength < OUTBOUND_URL_MAX_BYTES);
  const encodedFormBytes = new TextEncoder().encode(statCall.form.toString()).byteLength;
  assert.ok(encodedFormBytes > OUTBOUND_URL_MAX_BYTES);
  assert.ok(encodedFormBytes < PCLOUD_FORM_BODY_MAX_BYTES);

  const acceptedFolderId = "9".repeat(PCLOUD_ID_MAX_DECIMAL_DIGITS);
  setScenario({
    rootPath: "/",
    listMetadata: { isfolder: true, contents: [] },
  });
  result = await callTool(
    "list_folder",
    { folderId: acceptedFolderId },
    { PCLOUD_ROOT_PATH: "/" },
  );
  assert.equal(result.isError, undefined);
  const folderCall = fetchCalls.find(({ url }) => url.pathname === "/listfolder");
  assert.equal(folderCall.form.get("folderid"), acceptedFolderId);

  setScenario({ rootPath: "/" });
  result = await callTool(
    "list_folder",
    { folderId: "9".repeat(PCLOUD_ID_MAX_DECIMAL_DIGITS + 1) },
    { PCLOUD_ROOT_PATH: "/" },
  );
  assert.equal(result.isError, true);
  assert.equal(pCloudCallCount("/listfolder"), 0);

  const bytes = new TextEncoder().encode("hello");
  setScenario({
    virtualPath: "/Documents/note.md",
    bytes,
    metadata: {
      isfolder: false,
      name: "note.md",
      path: `${ROOT_PATH}/Documents/note.md`,
      fileid: "42",
      size: bytes.byteLength,
      contenttype: "text/markdown",
    },
    getfilelinkResponseFactory() {
      return jsonResponse({
        result: 0,
        hosts: [CONTENT_HOST],
        path: `/${"x".repeat(OUTBOUND_URL_MAX_BYTES)}`,
      });
    },
  });
  result = await callTool("read_file", { path: scenario.virtualPath });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /outbound URL safety limit/);
  assert.equal(
    fetchCalls.filter(({ url }) => url.hostname === CONTENT_HOST).length,
    0,
  );
});

test("aggregate path, queue, and result budgets fail closed before amplification", async () => {
  const overlongPath = `/${Array.from({ length: 17 }, () => "p".repeat(1000)).join("/")}`;
  setScenario();
  let result = await callTool("get_file_info", { path: overlongPath });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /16384-byte path safety limit/);
  assert.equal(pCloudCallCount("/stat"), 0);

  const metadataCanary = `METADATA_CANARY_${"m".repeat(MCP_METADATA_RESULT_MAX_BYTES)}`;
  setScenario({
    virtualPath: "/Documents/large-metadata.txt",
    metadata: {
      isfolder: false,
      name: "large-metadata.txt",
      path: `${ROOT_PATH}/Documents/large-metadata.txt`,
      fileid: "42",
      size: 1,
      contenttype: metadataCanary,
    },
  });
  result = await callTool("get_file_info", { path: scenario.virtualPath });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /file metadata/i);
  assert.match(result.content[0].text, /aggregate response safety limit/);
  assert.ok(!JSON.stringify(result).includes("METADATA_CANARY"));
  assert.equal(pCloudCallCount("/stat"), 1);

  const longListEntries = Array.from({ length: 500 }, (_, index) => {
    const prefix = `${String(index).padStart(4, "0")}-`;
    return {
      isfolder: false,
      name: `${prefix}${"l".repeat(1022 - prefix.length)}`,
      size: 1,
    };
  });
  setScenario({
    listMetadata: { isfolder: true, contents: longListEntries },
  });
  result = await callTool("list_folder", { path: "/", maxEntries: 500 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /aggregate response safety limit/);
  assert.match(result.content[0].text, /no complete folder listing/);
  assert.ok(!JSON.stringify(result).includes(longListEntries[0].name));
  assert.equal(pCloudCallCount("/listfolder"), 1);

  setScenario({
    listMetadata: {
      isfolder: true,
      contents: Array.from(
        { length: SEARCH_MAX_PENDING_FOLDERS + 1 },
        (_, index) => ({ isfolder: true, name: `folder-${index}` }),
      ),
    },
  });
  result = await callTool(
    "search_files",
    { query: "absent", path: "/" },
    { PCLOUD_SEARCH_MAX_FOLDER_CALLS: "1024" },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /2048-pending-folder safety limit/);
  assert.match(result.content[0].text, /no complete search result/);
  assert.equal(pCloudCallCount("/listfolder"), 1);

  const longPendingFolders = Array.from({ length: 1_100 }, (_, index) => {
    const prefix = `folder-${index}-`;
    return {
      isfolder: true,
      name: `${prefix}${"q".repeat(1000 - prefix.length)}`,
    };
  });
  setScenario({
    listMetadata: { isfolder: true, contents: longPendingFolders },
  });
  result = await callTool(
    "search_files",
    { query: "absent", path: "/" },
    { PCLOUD_SEARCH_MAX_FOLDER_CALLS: "1024" },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /2097152-byte pending-path safety limit/);
  assert.match(result.content[0].text, /no complete search result/);
  assert.equal(pCloudCallCount("/listfolder"), 1);

  const longBasePath = `/${Array.from({ length: 14 }, () => "b".repeat(1000)).join("/")}`;
  const physicalLongBasePath = `${ROOT_PATH}${longBasePath}`;
  const longMatchingFiles = Array.from({ length: 70 }, (_, index) => {
    const prefix = `match-${index}-`;
    return {
      isfolder: false,
      name: `${prefix}${"r".repeat(1000 - prefix.length)}`,
      size: 1,
    };
  });
  setScenario({
    listMetadataByPath: {
      [physicalLongBasePath]: {
        isfolder: true,
        contents: longMatchingFiles,
      },
    },
  });
  result = await callTool("search_files", {
    query: "match",
    path: longBasePath,
    maxResults: 200,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /aggregate response safety limit/);
  assert.match(result.content[0].text, /no complete search result/);
  assert.ok(!JSON.stringify(result).includes(longMatchingFiles[0].name));
  assert.equal(pCloudCallCount("/listfolder"), 1);
});

test("search defaults to 45 folder calls and rejects incomplete traversal explicitly", async () => {
  setScenario({
    listResponseFactory: ({ requestedPath }) =>
      jsonResponse({
        result: 0,
        metadata: {
          path: requestedPath,
          isfolder: true,
          contents:
            requestedPath === ROOT_PATH
              ? Array.from(
                  { length: SEARCH_DEFAULT_MAX_FOLDER_API_CALLS },
                  (_, index) => ({
                    isfolder: true,
                    name: `folder-${index}`,
                  }),
                )
              : [],
        },
      }),
  });
  const result = await callTool("search_files", {
    query: "absent",
    path: "/",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /45-folder\/API-call safety limit/);
  assert.match(result.content[0].text, /no complete search result/);
  assert.match(result.content[0].text, /narrower path/);
  assert.match(
    result.content[0].text,
    /plan with sufficient external subrequest allowance/,
  );
  assert.equal(
    pCloudCallCount("/listfolder"),
    SEARCH_DEFAULT_MAX_FOLDER_API_CALLS,
  );
});

test("search honors configured folder-call limits and succeeds exactly at the limit", async () => {
  setScenario({
    listMetadataByPath: {
      [ROOT_PATH]: {
        isfolder: true,
        contents: [{ isfolder: true, name: "Folder" }],
      },
      [`${ROOT_PATH}/Folder`]: {
        isfolder: true,
        contents: [{ isfolder: false, name: "match.txt", size: 1 }],
      },
    },
  });

  let result = parseToolText(
    await callTool(
      "search_files",
      { query: "match", path: "/" },
      { PCLOUD_SEARCH_MAX_FOLDER_CALLS: "2" },
    ),
  );
  assert.equal(result.folderApiCalls, 2);
  assert.equal(result.scannedEntries, 2);
  assert.equal(result.totalMatches, 1);
  assert.equal(result.safetyLimits.maxFolderApiCalls, 2);
  assert.equal(
    result.safetyLimits.maxPCloudJsonBytes,
    SEARCH_PCLOUD_JSON_MAX_BYTES,
  );
  assert.ok(result.pCloudJsonBytes > 0);
  assert.ok(result.pCloudJsonBytes <= SEARCH_PCLOUD_JSON_MAX_BYTES);
  assert.equal(pCloudCallCount("/listfolder"), 2);

  setScenario({
    listMetadataByPath: {
      [ROOT_PATH]: {
        isfolder: true,
        contents: [{ isfolder: true, name: "Folder" }],
      },
      [`${ROOT_PATH}/Folder`]: { isfolder: true, contents: [] },
    },
  });
  result = await callTool(
    "search_files",
    { query: "absent", path: "/" },
    { PCLOUD_SEARCH_MAX_FOLDER_CALLS: "1" },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /1-folder\/API-call safety limit/);
  assert.match(result.content[0].text, /no complete search result/);
  assert.equal(pCloudCallCount("/listfolder"), 1);
});

test("search fails closed on malformed folder-call configuration", async () => {
  setScenario({
    listMetadata: { isfolder: true, contents: [] },
  });
  const result = await callTool(
    "search_files",
    { query: "absent", path: "/" },
    { PCLOUD_SEARCH_MAX_FOLDER_CALLS: "045" },
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "PCLOUD_SEARCH_MAX_FOLDER_CALLS must be a canonical integer from 1 to 1024.",
  );
  assert.equal(pCloudCallCount("/listfolder"), 0);
});

test("search distinguishes a folder JSON overflow and propagates traversal API errors", async () => {
  setScenario({
    listResponseFactory: () =>
      streamingResponse([], {
        headers: {
          "content-type": "application/json",
          "content-length": String(PCLOUD_JSON_MAX_BYTES + 1),
        },
        onCancel() {
          pCloudApiCancelCount += 1;
        },
        keepOpenOnExhaustion: true,
      }),
  });
  let result = await callTool("search_files", { query: "a", path: "/" });
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    `pCloud JSON response exceeded the ${PCLOUD_JSON_MAX_BYTES}-byte safety limit.`,
  );
  assert.equal(pCloudApiCancelCount, 1);

  setScenario({
    listResponseFactory: ({ requestedPath }) =>
      requestedPath === ROOT_PATH
        ? jsonResponse({
            result: 0,
            metadata: {
              path: requestedPath,
              isfolder: true,
              contents: [{ isfolder: true, name: "Folder" }],
            },
          })
        : jsonResponse({ result: 2000 }),
  });
  result = await callTool("search_files", { query: "folder", path: "/" });
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "pCloud API request failed with result code 2000.",
  );
  assert.equal(pCloudCallCount("/listfolder"), 2);
});

test("search enforces its aggregate pCloud JSON budget across large responses", async () => {
  const padding = "x".repeat(3 * 1024 * 1024);
  let responseIndex = 0;
  setScenario({
    listResponseFactory: ({ requestedPath }) => {
      responseIndex += 1;
      if (responseIndex === 6) {
        return streamingResponse([], {
          headers: {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024),
          },
          onCancel() {
            pCloudApiCancelCount += 1;
          },
          keepOpenOnExhaustion: true,
        });
      }
      return jsonResponse({
        result: 0,
        metadata: {
          path: requestedPath,
          isfolder: true,
          padding,
          contents: [{ isfolder: true, name: `folder-${responseIndex}` }],
        },
      });
    },
  });

  let result = await callTool(
    "search_files",
    { query: "absent", path: "/" },
    { PCLOUD_SEARCH_MAX_FOLDER_CALLS: "1024" },
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    `Search exceeded the ${SEARCH_PCLOUD_JSON_MAX_BYTES}-byte aggregate pCloud JSON response safety limit; no complete search result was returned. Retry with a narrower path.`,
  );
  assert.equal(pCloudCallCount("/listfolder"), 6);
  assert.equal(pCloudApiCancelCount, 1);

  responseIndex = 0;
  setScenario({
    listResponseFactory: ({ requestedPath }) => {
      responseIndex += 1;
      if (responseIndex === 6) {
        return streamingResponse(
          [
            new Uint8Array(700 * 1024),
            new Uint8Array(700 * 1024),
          ],
          {
            headers: { "content-type": "application/json" },
            onCancel() {
              pCloudApiCancelCount += 1;
            },
            keepOpenOnExhaustion: true,
          },
        );
      }
      return jsonResponse({
        result: 0,
        metadata: {
          path: requestedPath,
          isfolder: true,
          padding,
          contents: [{ isfolder: true, name: `folder-${responseIndex}` }],
        },
      });
    },
  });

  result = await callTool(
    "search_files",
    { query: "absent", path: "/" },
    { PCLOUD_SEARCH_MAX_FOLDER_CALLS: "1024" },
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    `Search exceeded the ${SEARCH_PCLOUD_JSON_MAX_BYTES}-byte aggregate pCloud JSON response safety limit; no complete search result was returned. Retry with a narrower path.`,
  );
  assert.equal(pCloudCallCount("/listfolder"), 6);
  assert.equal(pCloudApiCancelCount, 1);
});

test("search refuses response-derived paths that could escape the virtual root", async () => {
  setScenario({
    listMetadata: {
      isfolder: true,
      contents: [{ isfolder: true, name: ".." }],
    },
  });
  const result = await callTool("search_files", {
    query: "outside",
    path: "/",
  });
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "pCloud listfolder returned an invalid entry name.",
  );
  assert.equal(pCloudCallCount("/listfolder"), 1);
  assert.ok(!JSON.stringify(result).includes(ROOT_PATH));
});

test("virtual-root text retrieval and pre-download byte limits remain enforced", async () => {
  const bytes = new TextEncoder().encode("hello");
  setScenario({
    virtualPath: "/Documents/note.md",
    bytes,
    metadata: {
      isfolder: false,
      name: "note.md",
      id: "f42",
      fileid: 42,
      path: "/non-source/metadata-path",
      size: String(bytes.byteLength),
      contenttype: "text/markdown",
    },
  });
  const result = parseToolText(
    await callTool("read_file", { path: scenario.virtualPath, maxBytes: 5 }),
  );
  assert.equal(result.path, scenario.virtualPath);
  assert.equal(result.content, "hello");
  assert.equal(result.returnedBytes, bytes.byteLength);
  assert.equal(pCloudCallCount("/listfolder"), 1);
  assert.equal(pCloudCallCount("/getfilelink"), 1);
  assert.equal(pCloudCallCount(CONTENT_PATH), 1);
  assert.ok(!JSON.stringify(result).includes(ROOT_PATH));

  setScenario({
    virtualPath: "/Documents/note.md",
    bytes,
    metadata: {
      isfolder: false,
      name: "note.md",
      size: bytes.byteLength + 1,
      contenttype: "text/markdown",
    },
  });
  const shorterBody = await callTool("read_file", {
    path: scenario.virtualPath,
    maxBytes: bytes.byteLength + 1,
  });
  assert.equal(shorterBody.isError, true);
  assert.equal(
    shorterBody.content[0].text,
    "pCloud returned an incomplete or inconsistent text file body.",
  );

  setScenario({
    virtualPath: "/Documents/note.md",
    bytes,
    metadata: {
      isfolder: false,
      name: "note.md",
      size: bytes.byteLength - 1,
      contenttype: "text/markdown",
    },
  });
  const longerBody = await callTool("read_file", {
    path: scenario.virtualPath,
    maxBytes: bytes.byteLength,
  });
  assert.equal(longerBody.isError, true);
  assert.equal(
    longerBody.content[0].text,
    "pCloud returned an incomplete or inconsistent text file body.",
  );

  setScenario({
    virtualPath: "/Documents/note.md",
    metadata: {
      isfolder: false,
      name: "note.md",
      size: 6,
      contenttype: "text/markdown",
    },
  });
  const oversized = await callTool("read_file", {
    path: scenario.virtualPath,
    maxBytes: 5,
  });
  assert.equal(oversized.isError, true);
  assert.match(oversized.content[0].text, /exceeds the allowed maximum/);
  assert.equal(pCloudCallCount("/getfilelink"), 0);

  setScenario({
    virtualPath: "/Documents/note.md",
    bytes,
    metadata: {
      isfolder: false,
      name: "note.md",
      size: bytes.byteLength,
      contenttype: "text/markdown",
    },
    contentLength: "6",
    streamingChunks: [bytes],
    keepOpenOnExhaustion: true,
  });
  const contentLengthOverflow = await callTool("read_file", {
    path: scenario.virtualPath,
    maxBytes: 5,
  });
  assert.equal(contentLengthOverflow.isError, true);
  assert.match(contentLengthOverflow.content[0].text, /exceeds the allowed maximum/);
  assert.equal(contentCancelCount, 1);

  setScenario({
    virtualPath: "/Documents/note.md",
    metadata: {
      isfolder: false,
      name: "note.md",
      size: 5,
      contenttype: "text/markdown",
    },
    contentLength: null,
    streamingChunks: [bytes, new Uint8Array([0x21])],
    keepOpenOnExhaustion: true,
  });
  const streamedOverflow = await callTool("read_file", {
    path: scenario.virtualPath,
    maxBytes: 5,
  });
  assert.equal(streamedOverflow.isError, true);
  assert.match(streamedOverflow.content[0].text, /exceeds the allowed maximum/);
  assert.equal(contentCancelCount, 1);

  const upstreamErrorCanary =
    "TEMPORARY_URL_CANARY PHYSICAL_PATH_CANARY";
  setScenario({
    virtualPath: "/Documents/note.md",
    metadata: {
      isfolder: false,
      name: "note.md",
      size: bytes.byteLength,
      contenttype: "text/markdown",
    },
    contentLength: null,
    streamingChunks: [],
    contentStreamError: new Error(upstreamErrorCanary),
  });
  const streamFailure = await callTool("read_file", {
    path: scenario.virtualPath,
    maxBytes: bytes.byteLength,
  });
  assert.equal(streamFailure.isError, true);
  assert.equal(
    streamFailure.content[0].text,
    "pCloud content response stream failed.",
  );
  assert.ok(!JSON.stringify(streamFailure).includes(upstreamErrorCanary));
});

test("traversal is rejected before any pCloud request", async () => {
  setScenario();
  const result = await callTool("get_file_info", {
    path: "/Documents/../outside.txt",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must not contain/);
  assert.equal(pCloudCallCount("/stat"), 0);
});

test("bounded image and Office content regressions preserve original bytes", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  setScenario({
    virtualPath: "/Images/sample.png",
    bytes: png,
    metadata: {
      isfolder: false,
      name: "sample.png",
      path: "/non-source/metadata-path",
      size: png.byteLength,
      contenttype: "image/png",
    },
  });
  let result = await callTool("get_image_content", { path: scenario.virtualPath });
  assert.equal(result.content[0].type, "image");
  assert.equal(result.content[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(result.content[0].data, "base64"), Buffer.from(png));
  assert.equal(pCloudCallCount("/listfolder"), 1);

  const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
  setScenario({
    virtualPath: "/Documents/sample.docx",
    bytes: docx,
    metadata: {
      isfolder: false,
      name: "sample.docx",
      path: "/non-source/metadata-path",
      size: docx.byteLength,
      contenttype:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  });
  result = await callTool("get_office_content", { path: scenario.virtualPath });
  assert.equal(result.content[0].type, "resource");
  assert.equal(
    result.content[0].resource.mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.deepEqual(
    Buffer.from(result.content[0].resource.blob, "base64"),
    Buffer.from(docx),
  );
  assert.equal(pCloudCallCount("/listfolder"), 1);
});
