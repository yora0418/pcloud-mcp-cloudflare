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

let worker;
let bundleDirectory;
let accessJwt;
let scenario;
let fetchCalls = [];
let contentCancelCount = 0;

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function setScenario({
  virtualPath = "/Documents/note.md",
  metadata,
  bytes = new TextEncoder().encode("hello"),
  listMetadata,
  contentLength,
  streamingChunks,
  keepOpenOnExhaustion = false,
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
    contentLength:
      contentLength === undefined ? String(bytes.byteLength) : contentLength,
    streamingChunks,
    keepOpenOnExhaustion,
  };
  fetchCalls = [];
  contentCancelCount = 0;
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
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { alg: "RS256", use: "sig", kid: "mock-key" });
  accessJwt = await new SignJWT({ sub: "mock-user" })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuer(TEAM_DOMAIN)
    .setAudience(POLICY_AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

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
      assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
      assert.equal(url.searchParams.get("path"), `${ROOT_PATH}${scenario.virtualPath}`);
      return jsonResponse({ result: 0, metadata: scenario.metadata });
    }

    if (
      url.hostname === "api.pcloud.com" &&
      url.pathname === "/listfolder"
    ) {
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
      assert.equal(url.searchParams.get("path"), ROOT_PATH);
      return jsonResponse({ result: 0, metadata: scenario.listMetadata });
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
};
const context = {
  waitUntil() {},
  passThroughOnException() {},
};
let rpcId = 0;

async function rpc(method, params, overrides = {}) {
  rpcId += 1;
  const response = await worker.fetch(
    new Request("https://worker.example/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": accessJwt,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
    }),
    { ...env, ...overrides },
    context,
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
