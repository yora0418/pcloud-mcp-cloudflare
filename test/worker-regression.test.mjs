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
const SEARCH_MAX_FOLDER_API_CALLS = 1_024;

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
} = {}) {
  scenario = {
    virtualPath,
    metadata:
      metadata ??
      {
        isfolder: false,
        name: virtualPath.slice(virtualPath.lastIndexOf("/") + 1),
        id: "f42",
        fileid: 42,
        size: bytes.byteLength,
        contenttype: "text/markdown",
      },
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
    fetchCalls.push({ request, url });

    if (
      url.origin === TEAM_DOMAIN &&
      url.pathname === "/cdn-cgi/access/certs"
    ) {
      return jsonResponse({ keys: [publicJwk] });
    }

    if (url.hostname === "api.pcloud.com" && url.pathname === "/stat") {
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
      assert.equal(url.searchParams.get("path"), `${ROOT_PATH}${scenario.virtualPath}`);
      if (scenario.statResponseFactory) {
        return scenario.statResponseFactory();
      }
      return jsonResponse({ result: 0, metadata: scenario.metadata });
    }

    if (
      url.hostname === "api.pcloud.com" &&
      url.pathname === "/listfolder"
    ) {
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
      const requestedPath = url.searchParams.get("path");
      assert.ok(
        requestedPath === ROOT_PATH || requestedPath?.startsWith(`${ROOT_PATH}/`),
      );
      assert.equal(url.searchParams.get("recursive"), null);
      if (scenario.listResponseFactory) {
        return scenario.listResponseFactory({ request, requestedPath, url });
      }
      const metadata =
        scenario.listMetadataByPath?.[requestedPath] ??
        (requestedPath === ROOT_PATH ? scenario.listMetadata : undefined);
      return jsonResponse({ result: 0, metadata });
    }

    if (
      url.hostname === "api.pcloud.com" &&
      url.pathname === "/getfilelink"
    ) {
      assert.equal(request.method, "POST");
      assert.equal(url.search, "");
      assert.equal(request.redirect, "manual");
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get("path"), `${ROOT_PATH}${scenario.virtualPath}`);
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

async function callTool(name, args) {
  const response = await rpc("tools/call", { name, arguments: args });
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
    maxFolderApiCalls: SEARCH_MAX_FOLDER_API_CALLS,
  });
  assert.equal(
    fetchCalls
      .filter(({ url }) => url.pathname === "/listfolder")
      .some(({ url }) => url.searchParams.has("recursive")),
    false,
  );
  assert.equal(
    fetchCalls
      .filter(({ url }) => url.pathname === "/listfolder")
      .some(({ url }) => url.searchParams.has("folderid")),
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

test("search rejects scanned-entry and depth overflow without partial results", async () => {
  setScenario({
    listMetadata: {
      isfolder: true,
      contents: Array.from({ length: 10_001 }, (_, index) => ({
        isfolder: false,
        name: `entry-${index}.txt`,
        size: 1,
      })),
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
  errorResult = await callTool("search_files", {
    query: "level",
    path: "/",
  });
  assert.equal(errorResult.isError, true);
  assert.match(errorResult.content[0].text, /64-level nesting safety limit/);
  assert.match(errorResult.content[0].text, /no complete search result/);
  assert.equal(pCloudCallCount("/listfolder"), 65);
});

test("search enforces its folder API-call limit", async () => {
  setScenario({
    listResponseFactory: ({ requestedPath }) =>
      jsonResponse({
        result: 0,
        metadata: {
          isfolder: true,
          contents:
            requestedPath === ROOT_PATH
              ? Array.from(
                  { length: SEARCH_MAX_FOLDER_API_CALLS },
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
  assert.match(result.content[0].text, /1024-folder\/API-call safety limit/);
  assert.match(result.content[0].text, /no complete search result/);
  assert.equal(pCloudCallCount("/listfolder"), SEARCH_MAX_FOLDER_API_CALLS);
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
      size: png.byteLength,
      contenttype: "image/png",
    },
  });
  let result = await callTool("get_image_content", { path: scenario.virtualPath });
  assert.equal(result.content[0].type, "image");
  assert.equal(result.content[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(result.content[0].data, "base64"), Buffer.from(png));

  const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
  setScenario({
    virtualPath: "/Documents/sample.docx",
    bytes: docx,
    metadata: {
      isfolder: false,
      name: "sample.docx",
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
});
