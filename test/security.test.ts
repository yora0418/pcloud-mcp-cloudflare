import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTeamDomain } from "../src/access.ts";
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
