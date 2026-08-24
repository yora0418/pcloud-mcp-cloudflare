import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { verifyCloudflareAccess } from "./access";
import {
  checkMcpRateLimit,
  dispatchBoundedMcpRequest,
  McpRequestBodyError,
  type RateLimitBinding,
} from "./mcp-request-guards";
import {
  getPCloudSearchMaxFolderCalls,
  normalizePCloudApiHost,
} from "./pcloud-config";
import {
  optionalPCloudId,
  optionalPCloudSize,
  PCLOUD_ID_MAX_DECIMAL_DIGITS,
  safePCloudSizeNumber,
} from "./pcloud-metadata";

type McpHandler = ReturnType<typeof createMcpHandler>;
type McpBaseEnv = Parameters<McpHandler>[1];
type McpExecutionContext = Parameters<McpHandler>[2];

type Env = McpBaseEnv & {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  PCLOUD_ACCESS_TOKEN?: string;
  PCLOUD_API_HOST?: string;
  PCLOUD_ROOT_PATH?: string;
  PCLOUD_SEARCH_MAX_FOLDER_CALLS?: string;
  MCP_RATE_LIMITER?: RateLimitBinding;
};

type PCloudMetadata = Record<string, unknown> & {
  contents?: Array<Record<string, unknown>>;
};

type PCloudJsonResponse = {
  result: number;
  metadata?: PCloudMetadata;
};

type ToolInvocationContext = {
  clientSignal: AbortSignal;
  deadlineAt: number;
};

type PCloudJsonByteBudget = {
  limitBytes: number;
  usedBytes: number;
  errorMessage: string;
};

type PCloudFolderEntry = {
  metadata: Record<string, unknown>;
  name: string;
  isFolder: boolean;
};

class PCloudApiError extends Error {
  constructor(readonly resultCode: string) {
    super(`pCloud API request failed with result code ${resultCode}.`);
    this.name = "PCloudApiError";
  }
}

class PCloudContentLimitError extends Error {
  constructor(readonly allowedBytes: number) {
    super(`pCloud content response exceeded ${allowedBytes} bytes.`);
    this.name = "PCloudContentLimitError";
  }
}

class PCloudPathLimitError extends Error {
  constructor() {
    super("pCloud path exceeded the aggregate byte safety limit.");
    this.name = "PCloudPathLimitError";
  }
}

class PCloudJsonAggregateLimitError extends Error {
  constructor(readonly clientMessage: string) {
    super(clientMessage);
    this.name = "PCloudJsonAggregateLimitError";
  }
}

const PCLOUD_CONTENT_HOST_SUFFIX = ".pcloud.com";

const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const HARD_READ_MAX_BYTES = 1024 * 1024;
const HARD_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const HARD_OFFICE_MAX_BYTES = 1024 * 1024;
const PCLOUD_JSON_MAX_BYTES = 4 * 1024 * 1024;
const PCLOUD_GETFILELINK_JSON_MAX_BYTES = 64 * 1024;
const SEARCH_PCLOUD_JSON_MAX_BYTES = 16 * 1024 * 1024;
const SEARCH_MAX_SCANNED_ENTRIES = 10_000;
const SEARCH_MAX_DEPTH = 64;
const PCLOUD_PATH_MAX_BYTES = 16 * 1024;
const OUTBOUND_URL_MAX_BYTES = 16 * 1024;
const PCLOUD_FORM_BODY_MAX_BYTES = 64 * 1024;
const PCLOUD_METADATA_TIMEOUT_MS = 10_000;
const PCLOUD_GETFILELINK_TIMEOUT_MS = 10_000;
const PCLOUD_CONTENT_TIMEOUT_MS = 30_000;
const TOOL_INVOCATION_TIMEOUT_MS = 45_000;
const MCP_METADATA_RESULT_MAX_BYTES = 1024 * 1024;
const SEARCH_MAX_PENDING_FOLDERS = 2_048;
const SEARCH_MAX_PENDING_PATH_BYTES = 2 * 1024 * 1024;
const SEARCH_FOLDER_QUEUE_OVERHEAD_BYTES = 64;
const MCP_METADATA_RESULT_ENTRY_OVERHEAD_BYTES = 64;
const OOXML_ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;
const LOCAL_READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const PCLOUD_READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

type SupportedOfficeMimeType =
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation";
type SupportedOfficeFormat = {
  extension: ".docx" | ".xlsx" | ".pptx";
  mimeType: SupportedOfficeMimeType;
};

const SUPPORTED_OFFICE_FORMATS: readonly SupportedOfficeFormat[] = [
  {
    extension: ".docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    extension: ".xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  {
    extension: ".pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
];

type SupportedImageMimeType = "image/png" | "image/jpeg";
type SupportedImageFormat = {
  mimeType: SupportedImageMimeType;
  extensions: ReadonlySet<string>;
  signature: readonly number[];
};

const SUPPORTED_IMAGE_FORMATS: readonly SupportedImageFormat[] = [
  {
    mimeType: "image/png",
    extensions: new Set([".png"]),
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  {
    mimeType: "image/jpeg",
    extensions: new Set([".jpg", ".jpeg"]),
    signature: [0xff, 0xd8, 0xff],
  },
];

const TEXT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/markdown",
  "application/sql",
  "application/toml",
  "application/x-javascript",
  "application/x-markdown",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
]);

const GENERIC_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "application/unknown",
  "application/x-empty",
  "binary/octet-stream",
]);

const OFFICE_CONTAINER_FALLBACK_MIME_TYPES = new Set([
  ...GENERIC_MIME_TYPES,
  "application/zip",
  "application/x-zip-compressed",
]);

const TEXT_FILE_EXTENSIONS = new Set([
  ".bat",
  ".cfg",
  ".cmd",
  ".conf",
  ".css",
  ".csv",
  ".htm",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".markdown",
  ".md",
  ".ps1",
  ".py",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsv",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return true;
      }
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function retainedStringBudgetBytes(value: string): number {
  return Math.max(utf8ByteLength(value), value.length * 2);
}

function assertPathByteLimit(path: string): void {
  if (utf8ByteLength(path) > PCLOUD_PATH_MAX_BYTES) {
    throw new PCloudPathLimitError();
  }
}

function normalizeAbsolutePath(value: string, label: string): string {
  const path = value;

  if (path.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  if (!path.startsWith("/")) {
    throw new Error(`${label} must start with /.`);
  }

  if (path.length > 1 && path.endsWith("/")) {
    throw new Error(`${label} must not have a trailing slash.`);
  }

  if (path.includes("//")) {
    throw new Error(`${label} must not contain empty path segments.`);
  }

  if (path.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/.test(path)) {
    throw new Error(`${label} contains an unsupported path character.`);
  }

  if (hasUnpairedSurrogate(path)) {
    throw new Error(`${label} contains an unsupported Unicode sequence.`);
  }

  const segments = path === "/" ? [] : path.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain . or .. path segments.`);
  }

  if (
    segments.some(
      (segment) => utf8ByteLength(segment) >= 1024,
    )
  ) {
    throw new Error(`${label} contains a path segment that is too long.`);
  }

  try {
    assertPathByteLimit(path);
  } catch (error) {
    if (error instanceof PCloudPathLimitError) {
      throw new Error(
        `${label} exceeds the ${PCLOUD_PATH_MAX_BYTES}-byte path safety limit.`,
      );
    }
    throw error;
  }

  return path;
}

function getPCloudConfig(env: Env) {
  if (!env.PCLOUD_ACCESS_TOKEN || !env.PCLOUD_API_HOST) {
    throw new Error(
      `pCloud is not configured. PCLOUD_ACCESS_TOKEN=${Boolean(env.PCLOUD_ACCESS_TOKEN)} PCLOUD_API_HOST=${Boolean(env.PCLOUD_API_HOST)}`,
    );
  }

  const rootPath = normalizeAbsolutePath(
    env.PCLOUD_ROOT_PATH === undefined ? "/" : env.PCLOUD_ROOT_PATH,
    "PCLOUD_ROOT_PATH",
  );

  return {
    accessToken: env.PCLOUD_ACCESS_TOKEN,
    apiHost: normalizePCloudApiHost(env.PCLOUD_API_HOST),
    rootPath,
  };
}

function normalizeVirtualPath(value?: string): string {
  return normalizeAbsolutePath(
    value === undefined ? "/" : value,
    "Virtual pCloud path",
  );
}

function resolveVirtualPath(env: Env, value?: string): {
  virtualPath: string;
  physicalPath: string;
} {
  const { rootPath } = getPCloudConfig(env);
  const virtualPath = normalizeVirtualPath(value);

  if (rootPath === "/") {
    return { virtualPath, physicalPath: virtualPath };
  }

  const physicalPath =
    virtualPath === "/" ? rootPath : `${rootPath}${virtualPath}`;
  try {
    assertPathByteLimit(physicalPath);
  } catch (error) {
    if (error instanceof PCloudPathLimitError) {
      throw new Error(
        `Resolved pCloud path exceeds the ${PCLOUD_PATH_MAX_BYTES}-byte path safety limit.`,
      );
    }
    throw error;
  }

  return {
    virtualPath,
    physicalPath,
  };
}

function joinVirtualPath(parentPath: string, name: string): string {
  const joined = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
  assertPathByteLimit(joined);
  return joined;
}

function relativeSearchPath(basePath: string, fullPath: string): string {
  if (basePath === "/") {
    return fullPath;
  }

  if (fullPath === basePath) {
    return "/";
  }

  if (fullPath.startsWith(`${basePath}/`)) {
    return fullPath.slice(basePath.length);
  }

  return fullPath;
}

function validateSearchQuery(value: string): string {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error("query contains an unsupported control character.");
  }

  if (hasUnpairedSurrogate(value)) {
    throw new Error("query contains an unsupported Unicode sequence.");
  }

  if (/^\s*$/u.test(value)) {
    throw new Error("query must contain at least one non-whitespace character.");
  }

  return value;
}

function assertOutboundUrlByteLimit(url: URL, context: string): void {
  if (utf8ByteLength(url.href) > OUTBOUND_URL_MAX_BYTES) {
    throw new Error(
      `${context} exceeded the ${OUTBOUND_URL_MAX_BYTES}-byte outbound URL safety limit.`,
    );
  }
}

function createBoundedFormBody(
  params: Record<string, string>,
  context: string,
): URLSearchParams {
  const body = new URLSearchParams(params);
  if (utf8ByteLength(body.toString()) > PCLOUD_FORM_BODY_MAX_BYTES) {
    throw new Error(
      `${context} exceeded the ${PCLOUD_FORM_BODY_MAX_BYTES}-byte outbound parameter safety limit.`,
    );
  }
  return body;
}

function createToolInvocationContext(clientSignal: AbortSignal): ToolInvocationContext {
  return {
    clientSignal,
    deadlineAt: Date.now() + TOOL_INVOCATION_TIMEOUT_MS,
  };
}

function assertToolInvocationActive(context: ToolInvocationContext): void {
  if (context.clientSignal.aborted || Date.now() >= context.deadlineAt) {
    throw new Error("pCloud operation was canceled or exceeded its deadline.");
  }
}

function createPCloudFetchSignal(
  context: ToolInvocationContext,
  perFetchTimeoutMs: number,
): {
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
  deadlineLimited: boolean;
} {
  assertToolInvocationActive(context);
  const remainingMs = context.deadlineAt - Date.now();
  const effectiveTimeoutMs = Math.max(
    1,
    Math.min(perFetchTimeoutMs, remainingMs),
  );
  const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);

  return {
    signal: AbortSignal.any([context.clientSignal, timeoutSignal]),
    timeoutSignal,
    deadlineLimited: remainingMs <= perFetchTimeoutMs,
  };
}

function pCloudFetchFailureMessage(
  context: ToolInvocationContext,
  timeoutSignal: AbortSignal,
  deadlineLimited: boolean,
  perFetchTimeoutMessage: string,
  genericFailureMessage: string,
): string {
  if (
    context.clientSignal.aborted ||
    Date.now() >= context.deadlineAt ||
    (deadlineLimited && timeoutSignal.aborted)
  ) {
    return "pCloud operation was canceled or exceeded its deadline.";
  }
  if (timeoutSignal.aborted) {
    return perFetchTimeoutMessage;
  }
  return genericFailureMessage;
}

async function fetchPCloud(
  env: Env,
  context: ToolInvocationContext,
  method: string,
  params: Record<string, string>,
  accept: string,
): Promise<Response> {
  const { accessToken, apiHost } = getPCloudConfig(env);
  const url = new URL(`https://${apiHost}/${method}`);
  assertOutboundUrlByteLimit(url, "pCloud request URL");
  const body = createBoundedFormBody(params, "pCloud request parameters");
  const { signal, timeoutSignal, deadlineLimited } = createPCloudFetchSignal(
    context,
    PCLOUD_METADATA_TIMEOUT_MS,
  );

  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        Accept: accept,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      redirect: "manual",
      signal,
    });
  } catch {
    throw new Error(
      pCloudFetchFailureMessage(
        context,
        timeoutSignal,
        deadlineLimited,
        "pCloud metadata request timed out.",
        "pCloud request failed before a response was received.",
      ),
    );
  }
}

function parsePCloudResultCode(value: unknown): number {
  let result: number;

  if (typeof value === "number") {
    result = value;
  } else if (
    typeof value === "string" &&
    /^(?:0|[1-9]\d*)$/.test(value)
  ) {
    result = Number(value);
  } else {
    throw new Error("pCloud returned an invalid result code.");
  }

  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("pCloud returned an invalid result code.");
  }

  return result;
}

function isNonEmptyStringArray(
  value: unknown,
): value is [string, ...string[]] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item: unknown) => typeof item === "string" && item.trim().length > 0,
    )
  );
}

function normalizePCloudContentHost(value: string): string {
  if (
    hasUnpairedSurrogate(value) ||
    value !== value.trim() ||
    !value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("pCloud getfilelink returned an invalid response.");
  }

  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new Error("pCloud getfilelink returned an invalid response.");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    hostname !== value.toLowerCase() ||
    !hostname.endsWith(PCLOUD_CONTENT_HOST_SUFFIX)
  ) {
    throw new Error("pCloud getfilelink returned an invalid response.");
  }

  return hostname;
}

function buildPCloudContentUrl(host: string, path: string): URL {
  if (
    hasUnpairedSurrogate(path) ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new Error("pCloud getfilelink returned an invalid response.");
  }

  let url: URL;
  try {
    url = new URL(`https://${host}${path}`);
  } catch {
    throw new Error("pCloud getfilelink returned an invalid response.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== ""
  ) {
    throw new Error("pCloud getfilelink returned an invalid response.");
  }

  assertOutboundUrlByteLimit(url, "pCloud content URL");

  return url;
}

async function getPCloudFileContentUrl(
  env: Env,
  context: ToolInvocationContext,
  physicalPath: string,
): Promise<URL> {
  const { accessToken, apiHost } = getPCloudConfig(env);
  const url = new URL(`https://${apiHost}/getfilelink`);
  assertOutboundUrlByteLimit(url, "pCloud getfilelink URL");
  const body = createBoundedFormBody(
    {
      path: physicalPath,
      access_token: accessToken,
      forcedownload: "1",
      skipfilename: "1",
    },
    "pCloud getfilelink parameters",
  );
  const { signal, timeoutSignal, deadlineLimited } = createPCloudFetchSignal(
    context,
    PCLOUD_GETFILELINK_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      redirect: "manual",
      signal,
    });
  } catch {
    throw new Error(
      pCloudFetchFailureMessage(
        context,
        timeoutSignal,
        deadlineLimited,
        "pCloud getfilelink request timed out.",
        "pCloud getfilelink request failed before a response was received.",
      ),
    );
  }

  if (!response.ok) {
    throw new Error(`pCloud getfilelink HTTP error ${response.status}.`);
  }

  const rawData = await parseBoundedPCloudJson(
    response,
    PCLOUD_GETFILELINK_JSON_MAX_BYTES,
    "pCloud getfilelink returned an invalid response.",
    `pCloud getfilelink JSON response exceeded the ${PCLOUD_GETFILELINK_JSON_MAX_BYTES}-byte safety limit.`,
  );

  if (!isRecord(rawData)) {
    throw new Error("pCloud getfilelink returned an invalid response.");
  }

  const result = parsePCloudResultCode(rawData.result);
  if (result !== 0) {
    throw new PCloudApiError(String(result));
  }

  const hosts = rawData.hosts;
  if (
    !isNonEmptyStringArray(hosts) ||
    typeof rawData.path !== "string"
  ) {
    throw new Error("pCloud getfilelink returned an invalid response.");
  }

  const contentHost = normalizePCloudContentHost(hosts[0]);
  return buildPCloudContentUrl(contentHost, rawData.path);
}

async function fetchPCloudFileContent(
  context: ToolInvocationContext,
  url: URL,
): Promise<Response> {
  assertOutboundUrlByteLimit(url, "pCloud content URL");
  const { signal, timeoutSignal, deadlineLimited } = createPCloudFetchSignal(
    context,
    PCLOUD_CONTENT_TIMEOUT_MS,
  );
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal,
    });
  } catch {
    throw new Error(
      pCloudFetchFailureMessage(
        context,
        timeoutSignal,
        deadlineLimited,
        "pCloud content request timed out.",
        "pCloud content request failed before a response was received.",
      ),
    );
  }
}

function validatePCloudListResponseTarget(
  method: string,
  params: Record<string, string>,
  metadata: PCloudMetadata | undefined,
): void {
  if (method !== "listfolder") {
    return;
  }

  if (!metadata) {
    throw new Error(`pCloud ${method} response did not identify its target.`);
  }

  const requestedPath = params.path;
  if (requestedPath !== undefined) {
    if (metadata.path !== requestedPath) {
      throw new Error(`pCloud ${method} response did not match the requested target.`);
    }
    return;
  }

  const requestedFolderId = params.folderid;
  if (
    requestedFolderId !== undefined &&
    optionalPCloudId(metadata.folderid, metadata.id, "d") !== requestedFolderId
  ) {
    throw new Error(
      "pCloud listfolder response did not match the requested target.",
    );
  }
}

async function callPCloudJson(
  env: Env,
  context: ToolInvocationContext,
  method: string,
  params: Record<string, string>,
  aggregateBudget?: PCloudJsonByteBudget,
): Promise<PCloudJsonResponse> {
  if (
    aggregateBudget !== undefined &&
    aggregateBudget.usedBytes >= aggregateBudget.limitBytes
  ) {
    throw new PCloudJsonAggregateLimitError(aggregateBudget.errorMessage);
  }
  const response = await fetchPCloud(
    env,
    context,
    method,
    params,
    "application/json",
  );

  if (!response.ok) {
    throw new Error(`pCloud HTTP error ${response.status}.`);
  }

  const rawData = await parseBoundedPCloudJson(
    response,
    PCLOUD_JSON_MAX_BYTES,
    "pCloud returned an invalid JSON response.",
    `pCloud JSON response exceeded the ${PCLOUD_JSON_MAX_BYTES}-byte safety limit.`,
    aggregateBudget,
  );
  if (!isRecord(rawData)) {
    throw new Error("pCloud returned an invalid JSON response.");
  }

  const result = parsePCloudResultCode(rawData.result);
  const data: PCloudJsonResponse = {
    result,
    metadata: isRecord(rawData.metadata) ? rawData.metadata : undefined,
  };

  if (result !== 0) {
    throw new PCloudApiError(String(result));
  }

  validatePCloudListResponseTarget(method, params, data.metadata);

  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalScalarString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

function optionalHashString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : undefined;
}

function hasDefinedValue(value: Record<string, unknown>): boolean {
  return Object.values(value).some((field) => field !== undefined);
}

function getVirtualFileName(
  metadata: Record<string, unknown>,
  virtualPath: string,
): string {
  return (
    optionalString(metadata.name) ??
    virtualPath.slice(virtualPath.lastIndexOf("/") + 1)
  );
}

function normalizeFileMetadata(
  metadata: Record<string, unknown>,
  virtualPath: string,
) {
  const contentType = optionalString(metadata.contenttype);
  const icon = optionalString(metadata.icon);
  const category = optionalNumber(metadata.category);
  const normalizedMime = normalizeMimeType(contentType);
  const isImage =
    normalizedMime.startsWith("image/") || icon === "image" || category === 1;
  const isVideo =
    normalizedMime.startsWith("video/") || icon === "video" || category === 2;
  const isAudio =
    !isVideo &&
    (normalizedMime.startsWith("audio/") || icon === "audio" || category === 3);

  const image = {
    width: optionalNumber(metadata.width),
    height: optionalNumber(metadata.height),
  };
  const audio = {
    artist: optionalString(metadata.artist),
    album: optionalString(metadata.album),
    title: optionalString(metadata.title),
    genre: optionalString(metadata.genre),
    trackNo: optionalScalarString(metadata.trackno),
    codec: optionalString(metadata.audiocodec),
    bitrate: optionalNumber(metadata.audiobitrate),
    sampleRate: optionalNumber(metadata.audiosamplerate),
  };
  const video = {
    width: optionalNumber(metadata.width),
    height: optionalNumber(metadata.height),
    duration: optionalScalarString(metadata.duration),
    fps: optionalScalarString(metadata.fps),
    codec: optionalString(metadata.videocodec),
    bitrate: optionalNumber(metadata.videobitrate),
    audioCodec: optionalString(metadata.audiocodec),
    audioBitrate: optionalNumber(metadata.audiobitrate),
    audioSampleRate: optionalNumber(metadata.audiosamplerate),
  };

  return {
    name: getVirtualFileName(metadata, virtualPath),
    path: virtualPath,
    fileId: optionalPCloudId(metadata.fileid, metadata.id, "f"),
    size: optionalPCloudSize(metadata.size),
    contentType,
    created: optionalString(metadata.created),
    modified: optionalString(metadata.modified),
    hash: optionalHashString(metadata.hash),
    category,
    icon,
    ...(isImage && hasDefinedValue(image) ? { image } : {}),
    ...(isAudio && hasDefinedValue(audio) ? { audio } : {}),
    ...(isVideo && hasDefinedValue(video) ? { video } : {}),
  };
}

async function statVirtualFile(
  env: Env,
  context: ToolInvocationContext,
  path: string,
) {
  const resolved = resolveVirtualPath(env, path);

  if (resolved.virtualPath === "/") {
    throw new Error(
      'Virtual path "/" is a folder. Use list_folder to browse folders.',
    );
  }

  let data: PCloudJsonResponse;

  try {
    data = await callPCloudJson(env, context, "stat", {
      path: resolved.physicalPath,
    });
  } catch (error) {
    if (
      error instanceof PCloudApiError &&
      ["2002", "2009", "2010"].includes(error.resultCode)
    ) {
      throw new Error(
        `File not found at virtual path ${JSON.stringify(resolved.virtualPath)}.`,
      );
    }

    throw error;
  }

  const metadata = data.metadata;
  if (!metadata) {
    throw new Error("pCloud stat returned no file metadata.");
  }

  if (metadata.isfolder !== true && metadata.isfolder !== false) {
    throw new Error("pCloud stat returned invalid file metadata.");
  }

  await validatePCloudStatResponseTarget(env, context, resolved, metadata);

  if (metadata.isfolder === true) {
    throw new Error(
      `Virtual path ${JSON.stringify(resolved.virtualPath)} is a folder. Use list_folder to browse folders.`,
    );
  }

  return {
    virtualPath: resolved.virtualPath,
    physicalPath: resolved.physicalPath,
    metadata,
  };
}

function getFileSize(
  metadata: Record<string, unknown>,
  virtualPath: string,
): number {
  const size = safePCloudSizeNumber(metadata.size);
  if (size === undefined) {
    throw new Error(
      `File metadata for virtual path ${JSON.stringify(virtualPath)} does not contain a valid size.`,
    );
  }

  return size;
}

function normalizeMimeType(contentType?: string): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
}

function isSupportedTextFile(name: string, contentType?: string): boolean {
  const mime = normalizeMimeType(contentType);

  if (
    mime.startsWith("text/") ||
    TEXT_MIME_TYPES.has(mime) ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  ) {
    return true;
  }

  return (
    GENERIC_MIME_TYPES.has(mime) &&
    TEXT_FILE_EXTENSIONS.has(getFileExtension(name))
  );
}

function getExpectedImageFormat(
  name: string,
  contentType: string | undefined,
  virtualPath: string,
): SupportedImageFormat {
  const mimeType = normalizeMimeType(contentType);
  const metadataFormat = SUPPORTED_IMAGE_FORMATS.find(
    (format) => format.mimeType === mimeType,
  );
  if (metadataFormat) {
    return metadataFormat;
  }

  if (GENERIC_MIME_TYPES.has(mimeType)) {
    const extension = getFileExtension(name);
    const extensionFormat = SUPPORTED_IMAGE_FORMATS.find((format) =>
      format.extensions.has(extension),
    );
    if (extensionFormat) {
      return extensionFormat;
    }
  }

  throw new Error(
    `File at virtual path ${JSON.stringify(virtualPath)} is not a supported PNG or JPEG image.`,
  );
}

function hasByteSignature(
  bytes: Uint8Array,
  signature: readonly number[],
): boolean {
  return (
    bytes.byteLength >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte)
  );
}

function detectSupportedImageMimeType(
  bytes: Uint8Array,
): SupportedImageMimeType | undefined {
  return SUPPORTED_IMAGE_FORMATS.find((format) =>
    hasByteSignature(bytes, format.signature),
  )?.mimeType;
}

function getExpectedOfficeFormat(
  name: string,
  contentType: string | undefined,
  virtualPath: string,
): SupportedOfficeFormat {
  const extension = getFileExtension(name);
  const format = SUPPORTED_OFFICE_FORMATS.find(
    (candidate) => candidate.extension === extension,
  );
  if (!format) {
    throw new Error(
      `File at virtual path ${JSON.stringify(virtualPath)} is not a supported DOCX, XLSX, or PPTX file.`,
    );
  }

  const mimeType = normalizeMimeType(contentType);
  if (
    mimeType !== format.mimeType &&
    !OFFICE_CONTAINER_FALLBACK_MIME_TYPES.has(mimeType)
  ) {
    throw new Error(
      `File metadata at virtual path ${JSON.stringify(virtualPath)} does not match the expected Office format.`,
    );
  }

  return format;
}

async function createOfficeResourceUri(
  virtualPath: string,
  extension: SupportedOfficeFormat["extension"],
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(virtualPath),
    ),
  );
  const opaqueId = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `pcloud-office://content/${opaqueId}${extension}`;
}

function encodeBytesAsBase64(bytes: Uint8Array): string {
  const binaryChunks: string[] = [];
  const chunkSize = 32 * 1024;

  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binaryChunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }

  return btoa(binaryChunks.join(""));
}

async function readResponseBytesWithinLimit(
  response: Response,
  maxBytes: number,
  aggregateBudget?: PCloudJsonByteBudget,
): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const normalizedContentLength = contentLengthHeader.trim();
    if (!/^(?:0|[1-9]\d*)$/.test(normalizedContentLength)) {
      throw new Error("pCloud returned an invalid Content-Length header.");
    }

    const contentLength = Number(normalizedContentLength);
    if (!Number.isSafeInteger(contentLength)) {
      throw new Error("pCloud returned an invalid Content-Length header.");
    }

    if (contentLength > maxBytes) {
      try {
        await response.body?.cancel(
          "pCloud content response exceeded the byte limit.",
        );
      } catch {
        // The size limit error below remains the relevant failure.
      }
      throw new PCloudContentLimitError(maxBytes);
    }

    if (
      aggregateBudget !== undefined &&
      contentLength > aggregateBudget.limitBytes - aggregateBudget.usedBytes
    ) {
      try {
        await response.body?.cancel(
          "pCloud response exceeded the aggregate byte limit.",
        );
      } catch {
        // The aggregate size-limit error below remains the relevant failure.
      }
      throw new PCloudJsonAggregateLimitError(aggregateBudget.errorMessage);
    }
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (totalBytes + value.byteLength > maxBytes) {
        try {
          await reader.cancel(
            "pCloud content response exceeded the byte limit.",
          );
        } catch {
          // The size limit error below remains the relevant failure.
        }
        throw new PCloudContentLimitError(maxBytes);
      }

      if (
        aggregateBudget !== undefined &&
        value.byteLength >
          aggregateBudget.limitBytes - aggregateBudget.usedBytes
      ) {
        try {
          await reader.cancel(
            "pCloud response exceeded the aggregate byte limit.",
          );
        } catch {
          // The aggregate size-limit error below remains the relevant failure.
        }
        throw new PCloudJsonAggregateLimitError(aggregateBudget.errorMessage);
      }

      totalBytes += value.byteLength;
      if (aggregateBudget !== undefined) {
        aggregateBudget.usedBytes += value.byteLength;
      }
      chunks.push(value);
    }
  } catch (error) {
    if (
      error instanceof PCloudContentLimitError ||
      error instanceof PCloudJsonAggregateLimitError
    ) {
      throw error;
    }

    throw new Error("pCloud content response stream failed.");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function getRawPCloudFolderContents(
  metadata: Record<string, unknown> | undefined,
): unknown[] {
  if (
    !metadata ||
    metadata.isfolder !== true ||
    !Array.isArray(metadata.contents)
  ) {
    throw new Error("pCloud listfolder returned invalid folder metadata.");
  }

  return metadata.contents;
}

function parsePCloudFolderEntry(entry: unknown): PCloudFolderEntry {
  if (!isRecord(entry) || typeof entry.isfolder !== "boolean") {
    throw new Error("pCloud listfolder returned invalid entry metadata.");
  }

  const name = entry.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/.test(name) ||
    hasUnpairedSurrogate(name) ||
    new TextEncoder().encode(name).byteLength >= 1024
  ) {
    throw new Error("pCloud listfolder returned an invalid entry name.");
  }

  return {
    metadata: entry,
    name,
    isFolder: entry.isfolder,
  };
}

async function parseBoundedPCloudJson(
  response: Response,
  maxBytes: number,
  errorMessage: string,
  limitErrorMessage: string,
  aggregateBudget?: PCloudJsonByteBudget,
): Promise<unknown> {
  try {
    const bytes = await readResponseBytesWithinLimit(
      response,
      maxBytes,
      aggregateBudget,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof PCloudContentLimitError) {
      throw new Error(limitErrorMessage);
    }

    if (error instanceof PCloudJsonAggregateLimitError) {
      throw new Error(error.clientMessage);
    }

    throw new Error(errorMessage);
  }
}

function validatePCloudContentResponse(response: Response): void {
  if (!response.ok) {
    throw new Error(`pCloud content HTTP error ${response.status}.`);
  }

  const errorHeader = response.headers.get("X-Error");
  if (errorHeader !== null) {
    const normalizedErrorCode = errorHeader.trim();
    if (!/^\d+$/.test(normalizedErrorCode)) {
      throw new Error("pCloud returned an invalid X-Error header.");
    }

    const errorCode = Number(normalizedErrorCode);
    if (!Number.isSafeInteger(errorCode)) {
      throw new Error("pCloud returned an invalid X-Error header.");
    }

    if (errorCode !== 0) {
      throw new PCloudApiError(String(errorCode));
    }
  }
}

async function readPCloudFileBytes(
  env: Env,
  context: ToolInvocationContext,
  physicalPath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentUrl = await getPCloudFileContentUrl(env, context, physicalPath);
  const response = await fetchPCloudFileContent(context, contentUrl);
  validatePCloudContentResponse(response);
  return readResponseBytesWithinLimit(response, maxBytes);
}

async function readPCloudText(
  env: Env,
  context: ToolInvocationContext,
  physicalPath: string,
  maxBytes: number,
  expectedBytes: number,
): Promise<{ text: string; byteLength: number }> {
  const bytes = await readPCloudFileBytes(
    env,
    context,
    physicalPath,
    maxBytes,
  );
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      "pCloud returned an incomplete or inconsistent text file body.",
    );
  }
  let text: string;

  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    throw new Error("pCloud returned content that is not valid UTF-8 text.");
  }

  return { text, byteLength: bytes.byteLength };
}

function compactPCloudEntry(
  entry: PCloudFolderEntry,
  virtualPath?: string,
) {
  const { metadata, name, isFolder } = entry;

  return {
    type: isFolder ? "folder" : "file",
    name,
    path: virtualPath,
    folderId: isFolder
      ? optionalPCloudId(metadata.folderid, metadata.id, "d")
      : undefined,
    fileId: !isFolder
      ? optionalPCloudId(metadata.fileid, metadata.id, "f")
      : undefined,
    size: !isFolder ? optionalPCloudSize(metadata.size) : undefined,
    modified:
      typeof metadata.modified === "string" ? metadata.modified : undefined,
    contentType:
      !isFolder && typeof metadata.contenttype === "string"
        ? metadata.contenttype
        : undefined,
  };
}

function exactPCloudObjectId(
  metadata: Record<string, unknown>,
  isFolder: boolean,
): string | undefined {
  return isFolder
    ? optionalPCloudId(metadata.folderid, metadata.id, "d")
    : optionalPCloudId(metadata.fileid, metadata.id, "f");
}

async function validatePCloudStatResponseTarget(
  env: Env,
  context: ToolInvocationContext,
  resolved: { virtualPath: string; physicalPath: string },
  metadata: PCloudMetadata,
): Promise<void> {
  const separatorIndex = resolved.physicalPath.lastIndexOf("/");
  const requestedName = resolved.physicalPath.slice(separatorIndex + 1);
  const parentPath =
    separatorIndex === 0 ? "/" : resolved.physicalPath.slice(0, separatorIndex);
  const isFolder = metadata.isfolder === true;

  if (metadata.name !== requestedName) {
    throw new Error("pCloud stat response did not match the requested target.");
  }

  if (metadata.path === resolved.physicalPath) {
    return;
  }

  const parentData = await callPCloudJson(env, context, "listfolder", {
    path: parentPath,
  });
  const entries = getRawPCloudFolderContents(parentData.metadata);
  const statId = exactPCloudObjectId(metadata, isFolder);
  let matchingEntry: PCloudFolderEntry | undefined;
  let matchingEntryCount = 0;
  for (const rawEntry of entries) {
    const entry = parsePCloudFolderEntry(rawEntry);
    if (entry.name === requestedName && entry.isFolder === isFolder) {
      matchingEntry = entry;
      matchingEntryCount += 1;
    }
  }

  if (
    statId === undefined ||
    matchingEntryCount !== 1 ||
    !matchingEntry ||
    exactPCloudObjectId(matchingEntry.metadata, matchingEntry.isFolder) !==
      statId
  ) {
    throw new Error("pCloud stat response did not match the requested target.");
  }
}

function reserveMetadataResultBudget(
  usedBytes: number,
  value: unknown,
  limitErrorMessage: string,
): number {
  const serialized = JSON.stringify(value);
  const nextBytes =
    usedBytes +
    utf8ByteLength(serialized) +
    MCP_METADATA_RESULT_ENTRY_OVERHEAD_BYTES;
  if (nextBytes > MCP_METADATA_RESULT_MAX_BYTES) {
    throw new Error(limitErrorMessage);
  }
  return nextBytes;
}

function stringifyBoundedMetadataResult(
  value: unknown,
  limitErrorMessage: string,
): string {
  const serialized = JSON.stringify(value, null, 2);
  if (utf8ByteLength(serialized) > MCP_METADATA_RESULT_MAX_BYTES) {
    throw new Error(limitErrorMessage);
  }
  return serialized;
}

function searchFolderQueueBytes(folder: {
  virtualPath: string;
  physicalPath: string;
}): number {
  return (
    retainedStringBudgetBytes(folder.virtualPath) +
    retainedStringBudgetBytes(folder.physicalPath) +
    SEARCH_FOLDER_QUEUE_OVERHEAD_BYTES
  );
}

function createServer(env: Env, context: ToolInvocationContext) {
  const server = new McpServer({
    name: "pcloud-mcp-cloudflare",
    version: "0.1.0",
  });

  server.registerTool(
    "hello",
    {
      description: "Verify that the pCloud MCP Worker is running and reachable.",
      annotations: LOCAL_READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {
        name: z.string().optional().describe("Optional name to include in the response."),
      },
    },
    async ({ name }) => ({
      content: [
        {
          type: "text",
          text: name
            ? `pcloud-mcp-cloudflare is running. Hello, ${name}!`
            : "pcloud-mcp-cloudflare is running.",
        },
      ],
    }),
  );

  server.registerTool(
    "list_folder",
    {
      description:
        "List files and folders inside the configured pCloud virtual root. The visible path / maps to PCLOUD_ROOT_PATH when configured. This tool is read-only.",
      annotations: PCLOUD_READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {
        folderId: z
          .string()
          .max(PCLOUD_ID_MAX_DECIMAL_DIGITS)
          .regex(/^(?:0|[1-9]\d*)$/)
          .optional()
          .describe(
            "pCloud folder ID. Disabled when PCLOUD_ROOT_PATH scopes the MCP to a subfolder. Prefer path.",
          ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Virtual absolute folder path such as /Documents. Defaults to /. Paths cannot escape the configured virtual root.",
          ),
        maxEntries: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entries returned to the MCP client. Defaults to 200."),
      },
    },
    async ({ folderId, path, maxEntries }) => {
      try {
        if (folderId !== undefined && path !== undefined) {
          throw new Error("Specify either folderId or path, not both.");
        }

        const { rootPath } = getPCloudConfig(env);
        if (folderId !== undefined && rootPath !== "/") {
          throw new Error(
            "folderId access is disabled because PCLOUD_ROOT_PATH scopes this MCP to a virtual root. Use a virtual path instead.",
          );
        }

        let params: Record<string, string>;
        let requestedVirtualPath: string | undefined;

        if (folderId !== undefined) {
          params = { folderid: folderId };
        } else {
          const resolved = resolveVirtualPath(env, path);
          requestedVirtualPath = resolved.virtualPath;
          params = { path: resolved.physicalPath };
        }

        const data = await callPCloudJson(env, context, "listfolder", params);
        const folder = data.metadata;
        const contents = getRawPCloudFolderContents(folder);
        const limit = maxEntries ?? 200;
        const resultLimitError =
          `Folder listing exceeded the ${MCP_METADATA_RESULT_MAX_BYTES}-byte aggregate response safety limit; no complete folder listing was returned. Retry with a lower maxEntries.`;
        const entries: ReturnType<typeof compactPCloudEntry>[] = [];
        let resultBudgetBytes = 4 * 1024;

        for (let entryIndex = 0; entryIndex < contents.length; entryIndex += 1) {
          assertToolInvocationActive(context);
          const entry = parsePCloudFolderEntry(contents[entryIndex]);
          if (entryIndex >= limit) {
            continue;
          }
          let virtualEntryPath: string | undefined;
          if (requestedVirtualPath !== undefined) {
            try {
              virtualEntryPath = joinVirtualPath(
                requestedVirtualPath,
                entry.name,
              );
            } catch (error) {
              if (error instanceof PCloudPathLimitError) {
                throw new Error(
                  `Folder listing encountered a path exceeding the ${PCLOUD_PATH_MAX_BYTES}-byte safety limit; no complete folder listing was returned. Retry with a narrower path.`,
                );
              }
              throw error;
            }
          }

          const compactEntry = compactPCloudEntry(entry, virtualEntryPath);
          resultBudgetBytes = reserveMetadataResultBudget(
            resultBudgetBytes,
            compactEntry,
            resultLimitError,
          );
          entries.push(compactEntry);
        }

        const folderPath = requestedVirtualPath;
        const folderName =
          folderPath === "/"
            ? "/"
            : folderPath !== undefined
              ? folderPath.slice(folderPath.lastIndexOf("/") + 1)
              : undefined;

        const result = {
          folder: {
            name: folderName,
            path: folderPath,
            folderId: optionalPCloudId(folder?.folderid, folder?.id, "d"),
          },
          entries,
          totalEntries: contents.length,
          returnedEntries: entries.length,
          truncated: contents.length > entries.length,
        };

        return {
          content: [
            {
              type: "text",
              text: stringifyBoundedMetadataResult(result, resultLimitError),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unknown pCloud list_folder error.",
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "search_files",
    {
      description:
        "Search file and folder names/paths under the configured pCloud virtual root. This is metadata search only, not full-text file-content search. Matching is case-insensitive and read-only.",
      annotations: PCLOUD_READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe("Substring to search for in names and relative virtual paths."),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Virtual folder path to search within. Defaults to /. The search cannot leave the configured virtual root.",
          ),
        includeFolders: z
          .boolean()
          .optional()
          .describe("Include matching folders alongside files. Defaults to true."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum matching entries returned. Defaults to 50."),
      },
    },
    async ({ query, path, includeFolders, maxResults }) => {
      try {
        const needle = validateSearchQuery(query);

        const resolved = resolveVirtualPath(env, path);
        const maxFolderApiCalls = getPCloudSearchMaxFolderCalls(
          env.PCLOUD_SEARCH_MAX_FOLDER_CALLS,
        );
        const lowerNeedle = needle.toLowerCase();
        const returnFolders = includeFolders ?? true;
        const limit = maxResults ?? 50;
        const resultLimitError =
          `Search exceeded the ${MCP_METADATA_RESULT_MAX_BYTES}-byte aggregate response safety limit; no complete search result was returned. Retry with a lower maxResults or a narrower path.`;
        const matches: ReturnType<typeof compactPCloudEntry>[] = [];
        let resultBudgetBytes = 4 * 1024;
        let scannedEntries = 0;
        let totalMatches = 0;
        let folderApiCalls = 0;
        const pCloudJsonBudget: PCloudJsonByteBudget = {
          limitBytes: SEARCH_PCLOUD_JSON_MAX_BYTES,
          usedBytes: 0,
          errorMessage: `Search exceeded the ${SEARCH_PCLOUD_JSON_MAX_BYTES}-byte aggregate pCloud JSON response safety limit; no complete search result was returned. Retry with a narrower path.`,
        };

        type SearchFolder = {
          virtualPath: string;
          physicalPath: string;
          depth: number;
        };
        const rootSearchFolder: SearchFolder = {
          virtualPath: resolved.virtualPath,
          physicalPath: resolved.physicalPath,
          depth: 0,
        };
        const pendingFolders: Array<SearchFolder | undefined> = [
          rootSearchFolder,
        ];
        let nextFolderIndex = 0;
        let pendingFolderCount = 1;
        let pendingPathBytes = searchFolderQueueBytes(rootSearchFolder);

        while (nextFolderIndex < pendingFolders.length) {
          assertToolInvocationActive(context);
          if (folderApiCalls >= maxFolderApiCalls) {
            throw new Error(
              `Search reached the ${maxFolderApiCalls}-folder/API-call safety limit while folders remained; no complete search result was returned. Retry with a narrower path. Increasing PCLOUD_SEARCH_MAX_FOLDER_CALLS requires a Cloudflare Workers plan with sufficient external subrequest allowance.`,
            );
          }

          const folder = pendingFolders[nextFolderIndex];
          if (!folder) {
            throw new Error("Search encountered an invalid traversal state.");
          }
          pendingFolders[nextFolderIndex] = undefined;
          nextFolderIndex += 1;
          pendingFolderCount -= 1;
          pendingPathBytes -= searchFolderQueueBytes(folder);
          folderApiCalls += 1;
          const data = await callPCloudJson(
            env,
            context,
            "listfolder",
            { path: folder.physicalPath },
            pCloudJsonBudget,
          );
          const entries = getRawPCloudFolderContents(data.metadata);

          for (const rawEntry of entries) {
            assertToolInvocationActive(context);
            scannedEntries += 1;
            if (scannedEntries > SEARCH_MAX_SCANNED_ENTRIES) {
              throw new Error(
                `Search exceeded the ${SEARCH_MAX_SCANNED_ENTRIES}-entry safety limit; no complete search result was returned.`,
              );
            }

            const entry = parsePCloudFolderEntry(rawEntry);

            const entryDepth = folder.depth + 1;
            if (entryDepth > SEARCH_MAX_DEPTH) {
              throw new Error(
                `Search exceeded the ${SEARCH_MAX_DEPTH}-level nesting safety limit; no complete search result was returned.`,
              );
            }

            const { name, isFolder } = entry;
            let virtualPath: string;
            try {
              virtualPath = joinVirtualPath(folder.virtualPath, name);
            } catch (error) {
              if (error instanceof PCloudPathLimitError) {
                throw new Error(
                  `Search encountered a path exceeding the ${PCLOUD_PATH_MAX_BYTES}-byte safety limit; no complete search result was returned. Retry with a narrower path.`,
                );
              }
              throw error;
            }
            const relativePath = relativeSearchPath(
              resolved.virtualPath,
              virtualPath,
            );
            const matchesQuery =
              name.toLowerCase().includes(lowerNeedle) ||
              relativePath.toLowerCase().includes(lowerNeedle);

            if (matchesQuery && (returnFolders || !isFolder)) {
              totalMatches += 1;
              if (matches.length < limit) {
                const compactEntry = compactPCloudEntry(entry, virtualPath);
                resultBudgetBytes = reserveMetadataResultBudget(
                  resultBudgetBytes,
                  compactEntry,
                  resultLimitError,
                );
                matches.push(compactEntry);
              }
            }

            if (isFolder) {
              let physicalPath: string;
              try {
                physicalPath = joinVirtualPath(folder.physicalPath, name);
              } catch (error) {
                if (error instanceof PCloudPathLimitError) {
                  throw new Error(
                    `Search encountered a path exceeding the ${PCLOUD_PATH_MAX_BYTES}-byte safety limit; no complete search result was returned. Retry with a narrower path.`,
                  );
                }
                throw error;
              }

              const pendingFolder: SearchFolder = {
                virtualPath,
                physicalPath,
                depth: entryDepth,
              };
              const pendingFolderBytes = searchFolderQueueBytes(pendingFolder);
              if (pendingFolderCount >= SEARCH_MAX_PENDING_FOLDERS) {
                throw new Error(
                  `Search exceeded the ${SEARCH_MAX_PENDING_FOLDERS}-pending-folder safety limit; no complete search result was returned. Retry with a narrower path.`,
                );
              }
              if (
                pendingPathBytes + pendingFolderBytes >
                SEARCH_MAX_PENDING_PATH_BYTES
              ) {
                throw new Error(
                  `Search exceeded the ${SEARCH_MAX_PENDING_PATH_BYTES}-byte pending-path safety limit; no complete search result was returned. Retry with a narrower path.`,
                );
              }
              pendingFolders.push(pendingFolder);
              pendingFolderCount += 1;
              pendingPathBytes += pendingFolderBytes;
            }
          }
        }

        assertToolInvocationActive(context);

        const result = {
          query: needle,
          searchPath: resolved.virtualPath,
          includeFolders: returnFolders,
          matches,
          scannedEntries,
          folderApiCalls,
          pCloudJsonBytes: pCloudJsonBudget.usedBytes,
          totalMatches,
          returnedMatches: matches.length,
          truncated: totalMatches > matches.length,
          safetyLimits: {
            maxScannedEntries: SEARCH_MAX_SCANNED_ENTRIES,
            maxDepth: SEARCH_MAX_DEPTH,
            maxFolderApiCalls,
            maxPCloudJsonBytes: SEARCH_PCLOUD_JSON_MAX_BYTES,
            maxPathBytes: PCLOUD_PATH_MAX_BYTES,
            maxPendingFolders: SEARCH_MAX_PENDING_FOLDERS,
            maxPendingPathBytes: SEARCH_MAX_PENDING_PATH_BYTES,
            maxResultBytes: MCP_METADATA_RESULT_MAX_BYTES,
          },
          searchType: "metadata-name-and-path-substring",
        };

        return {
          content: [
            {
              type: "text",
              text: stringifyBoundedMetadataResult(result, resultLimitError),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unknown pCloud search_files error.",
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "get_file_info",
    {
      description:
        "Get normalized metadata for a file after its exact virtual path is known. The path stays inside the configured pCloud virtual root, and this tool is read-only.",
      annotations: PCLOUD_READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "Required virtual absolute file path such as /Documents/example.md. File IDs are not accepted.",
          ),
      },
    },
    async ({ path }) => {
      try {
        const file = await statVirtualFile(env, context, path);
        assertToolInvocationActive(context);
        const result = normalizeFileMetadata(
          file.metadata,
          file.virtualPath,
        );
        const resultLimitError =
          `File metadata exceeded the ${MCP_METADATA_RESULT_MAX_BYTES}-byte aggregate response safety limit; no complete file metadata was returned.`;

        return {
          content: [
            {
              type: "text",
              text: stringifyBoundedMetadataResult(result, resultLimitError),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unknown pCloud get_file_info error.",
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "get_image_content",
    {
      description:
        "Return a PNG or JPEG file directly as MCP ImageContent after validating its exact virtual path, file metadata, binary signature, and 5 MiB source-file limit. This tool is read-only.",
      annotations: PCLOUD_READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "Required virtual absolute PNG or JPEG path. File IDs are not accepted.",
          ),
      },
    },
    async ({ path }) => {
      try {
        const file = await statVirtualFile(env, context, path);
        assertToolInvocationActive(context);
        const name = getVirtualFileName(file.metadata, file.virtualPath);
        if (!name.trim()) {
          throw new Error("pCloud stat returned invalid image metadata.");
        }

        const contentType = optionalString(file.metadata.contenttype);
        const size = getFileSize(file.metadata, file.virtualPath);
        const expectedFormat = getExpectedImageFormat(
          name,
          contentType,
          file.virtualPath,
        );

        if (size > HARD_IMAGE_MAX_BYTES) {
          throw new Error(
            `Image at virtual path ${JSON.stringify(file.virtualPath)} is ${size} bytes, which exceeds the hard maximum of ${HARD_IMAGE_MAX_BYTES} bytes.`,
          );
        }

        let bytes: Uint8Array;
        try {
          bytes = await readPCloudFileBytes(
            env,
            context,
            file.physicalPath,
            HARD_IMAGE_MAX_BYTES,
          );
        } catch (error) {
          if (error instanceof PCloudContentLimitError) {
            throw new Error(
              `Image at virtual path ${JSON.stringify(file.virtualPath)} exceeds the hard maximum of ${error.allowedBytes} bytes.`,
            );
          }

          throw error;
        }

        assertToolInvocationActive(context);
        if (bytes.byteLength !== size) {
          throw new Error(
            "pCloud returned an incomplete or inconsistent image body.",
          );
        }

        const detectedMimeType = detectSupportedImageMimeType(bytes);
        if (detectedMimeType !== expectedFormat.mimeType) {
          throw new Error(
            "pCloud returned image content that does not match the expected PNG or JPEG format.",
          );
        }

        return {
          content: [
            {
              type: "image",
              data: encodeBytesAsBase64(bytes),
              mimeType: detectedMimeType,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unknown pCloud get_image_content error.",
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read UTF-8 content from a supported text file after its exact virtual path is known. Binary files are rejected. The default file-size limit is 256 KiB and the hard maximum is 1 MiB. This tool is read-only.",
      annotations: PCLOUD_READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "Required virtual absolute file path such as /Documents/example.md. File IDs are not accepted.",
          ),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(HARD_READ_MAX_BYTES)
          .optional()
          .describe(
            "Maximum complete file size allowed for this request. Defaults to 262144 bytes and cannot exceed 1048576 bytes. Partial reads are not returned.",
          ),
      },
    },
    async ({ path, maxBytes }) => {
      try {
        const allowedBytes = maxBytes ?? DEFAULT_READ_MAX_BYTES;
        const file = await statVirtualFile(env, context, path);
        assertToolInvocationActive(context);
        const size = getFileSize(file.metadata, file.virtualPath);

        if (size > allowedBytes) {
          throw new Error(
            `File at virtual path ${JSON.stringify(file.virtualPath)} is ${size} bytes, which exceeds the allowed maximum of ${allowedBytes} bytes.`,
          );
        }

        const name = getVirtualFileName(file.metadata, file.virtualPath);
        const contentType = optionalString(file.metadata.contenttype);
        if (!isSupportedTextFile(name, contentType)) {
          throw new Error(
            `File at virtual path ${JSON.stringify(file.virtualPath)} is not a supported text file. Binary and unsupported file content is not returned.`,
          );
        }

        let textResult: Awaited<ReturnType<typeof readPCloudText>>;
        try {
          textResult = await readPCloudText(
            env,
            context,
            file.physicalPath,
            allowedBytes,
            size,
          );
        } catch (error) {
          if (error instanceof PCloudContentLimitError) {
            throw new Error(
              `UTF-8 content for virtual path ${JSON.stringify(file.virtualPath)} exceeds the allowed maximum of ${error.allowedBytes} bytes.`,
            );
          }

          throw error;
        }

        assertToolInvocationActive(context);
        const result = {
          name,
          path: file.virtualPath,
          size,
          contentType,
          encoding: "utf-8",
          returnedBytes: textResult.byteLength,
          content: textResult.text,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unknown pCloud read_file error.",
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "get_office_content",
    {
      description:
        "Return a DOCX, XLSX, or PPTX file as an MCP embedded binary resource after validating its exact virtual path, Office metadata, ZIP signature, and 1 MiB source-file limit. This tool is read-only.",
      annotations: PCLOUD_READ_ONLY_TOOL_ANNOTATIONS,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "Required virtual absolute DOCX, XLSX, or PPTX path. File IDs are not accepted.",
          ),
      },
    },
    async ({ path }) => {
      try {
        const file = await statVirtualFile(env, context, path);
        assertToolInvocationActive(context);
        const name = getVirtualFileName(file.metadata, file.virtualPath);
        if (!name.trim()) {
          throw new Error("pCloud stat returned invalid Office file metadata.");
        }

        const contentType = optionalString(file.metadata.contenttype);
        const size = getFileSize(file.metadata, file.virtualPath);
        const format = getExpectedOfficeFormat(
          name,
          contentType,
          file.virtualPath,
        );

        if (size > HARD_OFFICE_MAX_BYTES) {
          throw new Error(
            `Office file at virtual path ${JSON.stringify(file.virtualPath)} is ${size} bytes, which exceeds the hard maximum of ${HARD_OFFICE_MAX_BYTES} bytes.`,
          );
        }

        let bytes: Uint8Array;
        try {
          bytes = await readPCloudFileBytes(
            env,
            context,
            file.physicalPath,
            HARD_OFFICE_MAX_BYTES,
          );
        } catch (error) {
          if (error instanceof PCloudContentLimitError) {
            throw new Error(
              `Office file at virtual path ${JSON.stringify(file.virtualPath)} exceeds the hard maximum of ${error.allowedBytes} bytes.`,
            );
          }

          throw error;
        }

        assertToolInvocationActive(context);
        if (bytes.byteLength !== size) {
          throw new Error(
            "pCloud returned an incomplete or inconsistent Office file body.",
          );
        }

        if (!hasByteSignature(bytes, OOXML_ZIP_SIGNATURE)) {
          throw new Error(
            "pCloud returned content that does not have the expected OOXML ZIP signature.",
          );
        }

        const resourceUri = await createOfficeResourceUri(
          file.virtualPath,
          format.extension,
        );

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: resourceUri,
                mimeType: format.mimeType,
                blob: encodeBytesAsBase64(bytes),
              },
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unknown pCloud get_office_content error.",
            },
          ],
        };
      }
    },
  );

  return server;
}

function createConfiguredMcpHandler(
  env: Env,
  context: ToolInvocationContext,
): McpHandler {
  return createMcpHandler(() => createServer(env, context), {
    maxSubscriptions: 0,
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: McpExecutionContext,
  ): Promise<Response> {
    const invocationContext = createToolInvocationContext(request.signal);
    const principal = await verifyCloudflareAccess(request, env);
    if (!principal) {
      return new Response("Forbidden", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      if (request.method === "POST") {
        const rateLimitDecision = await checkMcpRateLimit(
          env.MCP_RATE_LIMITER,
          principal.rateLimitKey,
        );
        if (rateLimitDecision === "limited") {
          return new Response("Too Many Requests", {
            status: 429,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "retry-after": "60",
            },
          });
        }
        if (rateLimitDecision === "unavailable") {
          return new Response("Service Unavailable", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }

        try {
          return await dispatchBoundedMcpRequest(
            request,
            (guardedRequest) => {
              const mcpHandler = createConfiguredMcpHandler(
                env,
                invocationContext,
              );
              return mcpHandler(guardedRequest, env, ctx);
            },
            { deadlineAt: invocationContext.deadlineAt },
          );
        } catch (error) {
          if (error instanceof McpRequestBodyError) {
            return new Response(error.message, {
              status: error.status,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          throw error;
        }
      }

      const mcpHandler = createConfiguredMcpHandler(
        env,
        invocationContext,
      );
      return mcpHandler(request, env, ctx);
    }

    if (url.pathname === "/") {
      return new Response(
        "pCloud MCP for Cloudflare Workers\nMCP endpoint: /mcp\n",
        {
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};
