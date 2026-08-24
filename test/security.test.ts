import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTeamDomain } from "../src/access.ts";
import {
  checkMcpRateLimit,
  dispatchBoundedMcpRequest,
  MCP_REQUEST_MAX_BYTES,
  McpRequestBodyError,
} from "../src/mcp-request-guards.ts";
import {
  getPCloudSearchMaxFolderCalls,
  normalizePCloudApiHost,
} from "../src/pcloud-config.ts";
import {
  optionalPCloudId,
  optionalPCloudSize,
  safePCloudSizeNumber,
} from "../src/pcloud-metadata.ts";

test("TEAM_DOMAIN accepts only canonical Cloudflare Access team origins", () => {
  assert.equal(
    normalizeTeamDomain("https://team-name.cloudflareaccess.com"),
    "https://team-name.cloudflareaccess.com",
  );
  assert.equal(
    normalizeTeamDomain("TEAM-NAME.cloudflareaccess.com"),
    "https://team-name.cloudflareaccess.com",
  );
  assert.equal(
    normalizeTeamDomain(" https://team-name.cloudflareaccess.com/ "),
    "https://team-name.cloudflareaccess.com",
  );

  for (const value of [
    "http://team-name.cloudflareaccess.com",
    "https://cloudflareaccess.com",
    "https://nested.team-name.cloudflareaccess.com",
    "https://team-name.cloudflareaccess.com:8443",
    "https://user@team-name.cloudflareaccess.com",
    "https://team-name.cloudflareaccess.com/certs",
    "https://team-name.cloudflareaccess.com/..",
    "https://team-name.cloudflareaccess.com/%2e%2e",
    "https://team-name.cloudflareaccess.com//",
    "https://team-name.cloudflareaccess.com?target=other",
    "https://team-name.cloudflareaccess.com#fragment",
    "https://team-name.cloudflareaccess.com.example",
  ]) {
    assert.throws(() => normalizeTeamDomain(value), /TEAM_DOMAIN/);
  }
});

test("pCloud identifiers preserve exact strings and reject unsafe numbers", () => {
  assert.equal(
    optionalPCloudId("9007199254740993", undefined, "f"),
    "9007199254740993",
  );
  assert.equal(
    optionalPCloudId(Number.MAX_SAFE_INTEGER, undefined, "f"),
    String(Number.MAX_SAFE_INTEGER),
  );
  assert.equal(
    optionalPCloudId(
      Number.MAX_SAFE_INTEGER + 1,
      "f9007199254740993",
      "f",
    ),
    "9007199254740993",
  );
  assert.equal(
    optionalPCloudId(Number.MAX_SAFE_INTEGER + 1, undefined, "f"),
    undefined,
  );
  assert.equal(
    optionalPCloudId(Number.MAX_SAFE_INTEGER + 1, "d9007199254740993", "f"),
    undefined,
  );
});

test("pCloud sizes keep exact strings without weakening numeric safety", () => {
  assert.equal(optionalPCloudSize("9007199254740993"), "9007199254740993");
  assert.equal(optionalPCloudSize(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(optionalPCloudSize(Number.MAX_SAFE_INTEGER + 1), undefined);
  assert.equal(optionalPCloudSize(-1), undefined);
  assert.equal(optionalPCloudSize(1.5), undefined);

  assert.equal(safePCloudSizeNumber("1048576"), 1048576);
  assert.equal(safePCloudSizeNumber(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(safePCloudSizeNumber("9007199254740993"), undefined);
  assert.equal(safePCloudSizeNumber(Number.MAX_SAFE_INTEGER + 1), undefined);
});

test("PCLOUD_API_HOST accepts only canonical regional API hosts", () => {
  assert.equal(normalizePCloudApiHost("api.pcloud.com"), "api.pcloud.com");
  assert.equal(
    normalizePCloudApiHost(" HTTPS://EAPI.PCLOUD.COM/ "),
    "eapi.pcloud.com",
  );

  for (const value of [
    "http://api.pcloud.com",
    "https://user@api.pcloud.com",
    "https://api.pcloud.com:8443",
    "https://api.pcloud.com/stat",
    "https://api.pcloud.com?method=stat",
    "https://api.pcloud.com#fragment",
    "https://api.pcloud.com//",
    "https://api.pcloud.com.example",
  ]) {
    assert.throws(() => normalizePCloudApiHost(value), /PCLOUD_API_HOST/);
  }
});

test("search folder-call configuration is canonical and bounded", () => {
  assert.equal(getPCloudSearchMaxFolderCalls(undefined), 45);
  assert.equal(getPCloudSearchMaxFolderCalls("1"), 1);
  assert.equal(getPCloudSearchMaxFolderCalls("73"), 73);
  assert.equal(getPCloudSearchMaxFolderCalls("1024"), 1_024);

  for (const value of [
    "",
    "0",
    "01",
    "+1",
    " 1",
    "1 ",
    "1.0",
    "1e2",
    "1025",
    "9999",
    "9007199254740993",
  ]) {
    assert.throws(
      () => getPCloudSearchMaxFolderCalls(value),
      /PCLOUD_SEARCH_MAX_FOLDER_CALLS/,
    );
  }
});

test("MCP ingress accepts bounded bodies and reconstructs the request", async () => {
  for (const length of [16, MCP_REQUEST_MAX_BYTES]) {
    const body = new Uint8Array(length);
    let dispatchCount = 0;
    const receivedLength = await dispatchBoundedMcpRequest(
      new Request("https://worker.example/mcp", {
        method: "POST",
        body,
      }),
      async (request) => {
        dispatchCount += 1;
        return (await request.arrayBuffer()).byteLength;
      },
    );
    assert.equal(dispatchCount, 1);
    assert.equal(receivedLength, length);
  }
});

test("MCP ingress rejects JSON-RPC batches before dispatch", async () => {
  for (const body of [
    "[]",
    " \r\n\t[{}]",
    new Uint8Array([0xef, 0xbb, 0xbf, 0x20, 0x5b, 0x5d]),
  ]) {
    let dispatchCount = 0;
    await assert.rejects(
      dispatchBoundedMcpRequest(
        new Request("https://worker.example/mcp", {
          method: "POST",
          body,
        }),
        () => {
          dispatchCount += 1;
        },
      ),
      (error: unknown) =>
        error instanceof McpRequestBodyError &&
        error.status === 400 &&
        error.message === "JSON-RPC batch requests are not supported.",
    );
    assert.equal(dispatchCount, 0);
  }
});

test("MCP ingress rejects declared oversized or malformed lengths before dispatch", async () => {
  for (const contentLength of [
    String(MCP_REQUEST_MAX_BYTES + 1),
    "01",
    "-1",
    "1.5",
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    let dispatchCount = 0;
    const request = new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { "content-length": contentLength },
      body: "{}",
    });

    await assert.rejects(
      dispatchBoundedMcpRequest(request, () => {
        dispatchCount += 1;
      }),
      (error: unknown) => {
        assert.ok(error instanceof McpRequestBodyError);
        assert.equal(
          error.status,
          contentLength === String(MCP_REQUEST_MAX_BYTES + 1) ? 413 : 400,
        );
        return true;
      },
    );
    assert.equal(dispatchCount, 0);
  }
});

test("MCP ingress counts a lengthless stream and cancels on actual overflow", async () => {
  let cancelCount = 0;
  let dispatchCount = 0;
  let chunkIndex = 0;
  const chunks = [
    new Uint8Array(MCP_REQUEST_MAX_BYTES),
    new Uint8Array([1]),
  ];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunks[chunkIndex]);
      chunkIndex += 1;
    },
    cancel() {
      cancelCount += 1;
    },
  });
  const request = new Request("https://worker.example/mcp", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    dispatchBoundedMcpRequest(request, () => {
      dispatchCount += 1;
    }),
    (error: unknown) =>
      error instanceof McpRequestBodyError && error.status === 413,
  );
  assert.equal(cancelCount, 1);
  assert.equal(dispatchCount, 0);
});

test("rate limiting isolates principal keys and fails closed when unavailable", async () => {
  const counts = new Map<string, number>();
  const binding = {
    async limit({ key }: { key: string }) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= 2 };
    },
  };

  assert.equal(await checkMcpRateLimit(binding, "sub:one"), "allowed");
  assert.equal(await checkMcpRateLimit(binding, "sub:one"), "allowed");
  assert.equal(await checkMcpRateLimit(binding, "sub:one"), "limited");
  assert.equal(await checkMcpRateLimit(binding, "sub:two"), "allowed");
  assert.equal(await checkMcpRateLimit(undefined, "sub:one"), "unavailable");
  assert.equal(
    await checkMcpRateLimit(
      { async limit() { throw new Error("unavailable"); } },
      "sub:one",
    ),
    "unavailable",
  );
  assert.equal(
    await checkMcpRateLimit(
      { async limit() { return {} as { success: boolean }; } },
      "sub:one",
    ),
    "unavailable",
  );
});
