import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

type McpHandler = ReturnType<typeof createMcpHandler>;
type McpBaseEnv = Parameters<McpHandler>[1];
type McpExecutionContext = Parameters<McpHandler>[2];

type Env = McpBaseEnv & {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  PCLOUD_ACCESS_TOKEN?: string;
  PCLOUD_API_HOST?: string;
  PCLOUD_ROOT_PATH?: string;
};

type PCloudMetadata = Record<string, unknown> & {
  contents?: Array<Record<string, unknown>>;
};

type PCloudJsonResponse = {
  result?: number | string;
  metadata?: PCloudMetadata;
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

const ALLOWED_PCLOUD_API_HOSTS = new Set([
  "api.pcloud.com",
  "eapi.pcloud.com",
]);
const PCLOUD_CONTENT_HOST_SUFFIX = ".pcloud.com";

const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const HARD_READ_MAX_BYTES = 1024 * 1024;
const HARD_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const HARD_OFFICE_MAX_BYTES = 1024 * 1024;
const MAX_OOXML_ENTRY_COUNT = 2048;
const MAX_OOXML_ENTRY_NAME_BYTES = 1024;
const MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_CRC32_TABLE = Array.from({ length: 256 }, (_, tableIndex) => {
  let value = tableIndex;
  for (let bit = 0; bit < 8; bit += 1) {
    value =
      (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
  }
  return value >>> 0;
});

type SupportedOfficeMimeType =
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation";
type SupportedOfficeFormat = {
  extension: ".docx" | ".xlsx" | ".pptx";
  mimeType: SupportedOfficeMimeType;
  mainPart: "word/document.xml" | "xl/workbook.xml" | "ppt/presentation.xml";
};
type ValidatedZipEntry = {
  compressionMethod: 0 | 8;
  crc32: number;
  uncompressedSize: number;
  dataOffset: number;
  dataEndOffset: number;
};

const SUPPORTED_OFFICE_FORMATS: readonly SupportedOfficeFormat[] = [
  {
    extension: ".docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    mainPart: "word/document.xml",
  },
  {
    extension: ".xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    mainPart: "xl/workbook.xml",
  },
  {
    extension: ".pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    mainPart: "ppt/presentation.xml",
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

function normalizePCloudApiHost(value: string): string {
  const raw = value.trim();
  const url = new URL(
    raw.startsWith("http://") || raw.startsWith("https://")
      ? raw
      : `https://${raw}`,
  );

  if (url.protocol !== "https:" || !ALLOWED_PCLOUD_API_HOSTS.has(url.hostname)) {
    throw new Error(
      "PCLOUD_API_HOST must be api.pcloud.com or eapi.pcloud.com.",
    );
  }

  return url.hostname;
}

function normalizeAbsolutePath(value: string, label: string): string {
  const path = value.trim();

  if (!path.startsWith("/")) {
    throw new Error(`${label} must start with /.`);
  }

  if (path.length > 1 && path.endsWith("/")) {
    throw new Error(`${label} must not have a trailing slash.`);
  }

  if (path.includes("//")) {
    throw new Error(`${label} must not contain empty path segments.`);
  }

  const segments = path.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain . or .. path segments.`);
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
    env.PCLOUD_ROOT_PATH?.trim() || "/",
    "PCLOUD_ROOT_PATH",
  );

  return {
    accessToken: env.PCLOUD_ACCESS_TOKEN,
    apiHost: normalizePCloudApiHost(env.PCLOUD_API_HOST),
    rootPath,
  };
}

function normalizeVirtualPath(value?: string): string {
  return normalizeAbsolutePath(value?.trim() || "/", "Virtual pCloud path");
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

  return {
    virtualPath,
    physicalPath: virtualPath === "/" ? rootPath : `${rootPath}${virtualPath}`,
  };
}

function joinVirtualPath(parentPath: string, name: string): string {
  return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
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

async function fetchPCloud(
  env: Env,
  method: string,
  params: Record<string, string>,
  accept: string,
): Promise<Response> {
  const { accessToken, apiHost } = getPCloudConfig(env);
  const url = new URL(`https://${apiHost}/${method}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  try {
    return await fetch(url, {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    throw new Error("pCloud request failed before a response was received.");
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

  return url;
}

async function getPCloudFileContentUrl(
  env: Env,
  physicalPath: string,
): Promise<URL> {
  const { accessToken, apiHost } = getPCloudConfig(env);
  const url = new URL(`https://${apiHost}/getfilelink`);
  const body = new URLSearchParams({
    path: physicalPath,
    access_token: accessToken,
    forcedownload: "1",
    skipfilename: "1",
  });

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
    });
  } catch {
    throw new Error(
      "pCloud getfilelink request failed before a response was received.",
    );
  }

  if (!response.ok) {
    throw new Error(`pCloud getfilelink HTTP error ${response.status}.`);
  }

  let rawData: unknown;
  try {
    rawData = await response.json();
  } catch {
    throw new Error("pCloud getfilelink returned an invalid JSON response.");
  }

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

async function fetchPCloudFileContent(url: URL): Promise<Response> {
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
    });
  } catch {
    throw new Error(
      "pCloud content request failed before a response was received.",
    );
  }
}

async function callPCloudJson(
  env: Env,
  method: string,
  params: Record<string, string>,
): Promise<PCloudJsonResponse> {
  const response = await fetchPCloud(
    env,
    method,
    params,
    "application/json",
  );

  if (!response.ok) {
    throw new Error(`pCloud HTTP error ${response.status}.`);
  }

  const rawData: unknown = await response.json();
  if (!isRecord(rawData)) {
    throw new Error("pCloud returned an invalid JSON response.");
  }

  const data: PCloudJsonResponse = {
    result:
      typeof rawData.result === "number" || typeof rawData.result === "string"
        ? rawData.result
        : undefined,
    metadata: isRecord(rawData.metadata) ? rawData.metadata : undefined,
  };
  const result = Number(data.result ?? 0);

  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("pCloud returned an invalid result code.");
  }

  if (result !== 0) {
    throw new PCloudApiError(String(result));
  }

  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMetadataContents(
  metadata: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const contents = metadata.contents;
  return Array.isArray(contents) ? contents.filter(isRecord) : [];
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
    fileId: optionalScalarString(metadata.fileid),
    size: optionalNumber(metadata.size),
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

async function statVirtualFile(env: Env, path: string) {
  const resolved = resolveVirtualPath(env, path);
  let data: PCloudJsonResponse;

  try {
    data = await callPCloudJson(env, "stat", {
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

  if (metadata.isfolder === true) {
    throw new Error(
      `Virtual path ${JSON.stringify(resolved.virtualPath)} is a folder. Use list_folder to browse folders.`,
    );
  }

  if (metadata.isfolder !== false) {
    throw new Error("pCloud stat returned invalid file metadata.");
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
  const size = optionalNumber(metadata.size);
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
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

function invalidOfficePackageError(): Error {
  return new Error(
    "pCloud returned an invalid or unsupported OOXML Office package.",
  );
}

function readZipUint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) {
    throw invalidOfficePackageError();
  }

  return bytes[offset] + bytes[offset + 1] * 0x100;
}

function readZipUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) {
    throw invalidOfficePackageError();
  }

  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  );
}

function findZipEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.byteLength < ZIP_END_OF_CENTRAL_DIRECTORY_BYTES) {
    throw invalidOfficePackageError();
  }

  const firstPossibleOffset = Math.max(
    0,
    bytes.byteLength -
      ZIP_END_OF_CENTRAL_DIRECTORY_BYTES -
      ZIP_MAX_COMMENT_BYTES,
  );

  for (
    let offset = bytes.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES;
    offset >= firstPossibleOffset;
    offset -= 1
  ) {
    if (
      readZipUint32(bytes, offset) ===
      ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      const commentLength = readZipUint16(bytes, offset + 20);
      if (
        offset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + commentLength ===
        bytes.byteLength
      ) {
        return offset;
      }
    }
  }

  throw invalidOfficePackageError();
}

function validateZipExtraFields(
  bytes: Uint8Array,
  offset: number,
  length: number,
): void {
  const endOffset = offset + length;
  if (endOffset > bytes.byteLength) {
    throw invalidOfficePackageError();
  }

  while (offset < endOffset) {
    if (offset + 4 > endOffset) {
      throw invalidOfficePackageError();
    }

    const headerId = readZipUint16(bytes, offset);
    const dataLength = readZipUint16(bytes, offset + 2);
    offset += 4;

    if (headerId === 0x0001 || offset + dataLength > endOffset) {
      throw invalidOfficePackageError();
    }

    offset += dataLength;
  }
}

function decodeZipEntryName(
  bytes: Uint8Array,
  offset: number,
  length: number,
  decoder: TextDecoder,
): string {
  if (
    length < 1 ||
    length > MAX_OOXML_ENTRY_NAME_BYTES ||
    offset + length > bytes.byteLength
  ) {
    throw invalidOfficePackageError();
  }

  let name: string;
  try {
    name = decoder.decode(bytes.subarray(offset, offset + length));
  } catch {
    throw invalidOfficePackageError();
  }

  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("//") ||
    name.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw invalidOfficePackageError();
  }

  const segments = name.split("/");
  const isDirectory = segments.at(-1) === "";
  const pathSegments = isDirectory ? segments.slice(0, -1) : segments;
  if (
    pathSegments.length === 0 ||
    pathSegments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw invalidOfficePackageError();
  }

  return name;
}

function zipByteRangesEqual(
  bytes: Uint8Array,
  firstOffset: number,
  secondOffset: number,
  length: number,
): boolean {
  if (
    firstOffset + length > bytes.byteLength ||
    secondOffset + length > bytes.byteLength
  ) {
    return false;
  }

  for (let index = 0; index < length; index += 1) {
    if (bytes[firstOffset + index] !== bytes[secondOffset + index]) {
      return false;
    }
  }

  return true;
}

function validateZipDataDescriptor(
  bytes: Uint8Array,
  offset: number,
  centralDirectoryOffset: number,
  crc32: number,
  compressedSize: number,
  uncompressedSize: number,
): number {
  if (
    offset + 16 <= centralDirectoryOffset &&
    readZipUint32(bytes, offset) === ZIP_DATA_DESCRIPTOR_SIGNATURE &&
    readZipUint32(bytes, offset + 4) === crc32 &&
    readZipUint32(bytes, offset + 8) === compressedSize &&
    readZipUint32(bytes, offset + 12) === uncompressedSize
  ) {
    return offset + 16;
  }

  if (
    offset + 12 <= centralDirectoryOffset &&
    readZipUint32(bytes, offset) === crc32 &&
    readZipUint32(bytes, offset + 4) === compressedSize &&
    readZipUint32(bytes, offset + 8) === uncompressedSize
  ) {
    return offset + 12;
  }

  throw invalidOfficePackageError();
}

function validateZipLocalEntry(
  bytes: Uint8Array,
  centralNameOffset: number,
  nameLength: number,
  localHeaderOffset: number,
  centralDirectoryOffset: number,
  generalPurposeFlags: number,
  compressionMethod: number,
  crc32: number,
  compressedSize: number,
  uncompressedSize: number,
): { start: number; end: number; dataOffset: number; dataEndOffset: number } {
  if (
    localHeaderOffset + 30 > centralDirectoryOffset ||
    readZipUint32(bytes, localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE
  ) {
    throw invalidOfficePackageError();
  }

  const localFlags = readZipUint16(bytes, localHeaderOffset + 6);
  const localCompressionMethod = readZipUint16(bytes, localHeaderOffset + 8);
  const localCrc32 = readZipUint32(bytes, localHeaderOffset + 14);
  const localCompressedSize = readZipUint32(bytes, localHeaderOffset + 18);
  const localUncompressedSize = readZipUint32(bytes, localHeaderOffset + 22);
  const localNameLength = readZipUint16(bytes, localHeaderOffset + 26);
  const localExtraLength = readZipUint16(bytes, localHeaderOffset + 28);
  const localNameOffset = localHeaderOffset + 30;
  const localExtraOffset = localNameOffset + localNameLength;
  const dataOffset = localExtraOffset + localExtraLength;
  const dataEndOffset = dataOffset + compressedSize;

  if (
    localFlags !== generalPurposeFlags ||
    localCompressionMethod !== compressionMethod ||
    localNameLength !== nameLength ||
    dataEndOffset > centralDirectoryOffset ||
    !zipByteRangesEqual(
      bytes,
      centralNameOffset,
      localNameOffset,
      nameLength,
    )
  ) {
    throw invalidOfficePackageError();
  }

  validateZipExtraFields(bytes, localExtraOffset, localExtraLength);

  const usesDataDescriptor = (generalPurposeFlags & 0x0008) !== 0;
  if (!usesDataDescriptor) {
    if (
      localCrc32 !== crc32 ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize
    ) {
      throw invalidOfficePackageError();
    }

    return {
      start: localHeaderOffset,
      end: dataEndOffset,
      dataOffset,
      dataEndOffset,
    };
  }

  if (
    ![0, crc32].includes(localCrc32) ||
    ![0, compressedSize].includes(localCompressedSize) ||
    ![0, uncompressedSize].includes(localUncompressedSize)
  ) {
    throw invalidOfficePackageError();
  }

  return {
    start: localHeaderOffset,
    end: validateZipDataDescriptor(
      bytes,
      dataEndOffset,
      centralDirectoryOffset,
      crc32,
      compressedSize,
      uncompressedSize,
    ),
    dataOffset,
    dataEndOffset,
  };
}

function updateZipCrc32(value: number, bytes: Uint8Array): number {
  for (const byte of bytes) {
    value = ZIP_CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

async function validateZipEntryContent(
  bytes: Uint8Array,
  entry: ValidatedZipEntry,
): Promise<void> {
  if (entry.compressionMethod === 0) {
    const content = bytes.subarray(entry.dataOffset, entry.dataEndOffset);
    const crc32 = (updateZipCrc32(0xffffffff, content) ^ 0xffffffff) >>> 0;
    if (content.byteLength !== entry.uncompressedSize || crc32 !== entry.crc32) {
      throw invalidOfficePackageError();
    }
    return;
  }

  const compressedBytes = bytes.subarray(
    entry.dataOffset,
    entry.dataEndOffset,
  );
  const compressedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (compressedBytes.byteLength > 0) {
        controller.enqueue(compressedBytes);
      }
      controller.close();
    },
  });

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const decompressor = new DecompressionStream(
      "deflate-raw",
    ) as unknown as TransformStream<Uint8Array, Uint8Array>;
    reader = compressedStream
      .pipeThrough(decompressor)
      .getReader();
  } catch {
    throw invalidOfficePackageError();
  }

  let actualSize = 0;
  let crc32 = 0xffffffff;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      actualSize += value.byteLength;
      if (actualSize > entry.uncompressedSize) {
        try {
          await reader.cancel("OOXML entry exceeded its declared size.");
        } catch {
          // The generic package-validation error below remains relevant.
        }
        throw invalidOfficePackageError();
      }

      crc32 = updateZipCrc32(crc32, value);
    }
  } catch {
    throw invalidOfficePackageError();
  } finally {
    reader.releaseLock();
  }

  const finalCrc32 = (crc32 ^ 0xffffffff) >>> 0;
  if (actualSize !== entry.uncompressedSize || finalCrc32 !== entry.crc32) {
    throw invalidOfficePackageError();
  }
}

function isMacroOfficePart(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName === "vbaproject.bin" ||
    normalizedName === "vbadata.xml" ||
    normalizedName.endsWith("/vbaproject.bin") ||
    normalizedName.endsWith("/vbadata.xml") ||
    normalizedName.startsWith("xl/macrosheets/") ||
    normalizedName.startsWith("xl/intlmacrosheets/")
  );
}

async function validateOfficePackage(
  bytes: Uint8Array,
  format: SupportedOfficeFormat,
): Promise<void> {
  const endOfCentralDirectoryOffset = findZipEndOfCentralDirectory(bytes);
  const diskNumber = readZipUint16(bytes, endOfCentralDirectoryOffset + 4);
  const centralDirectoryDisk = readZipUint16(
    bytes,
    endOfCentralDirectoryOffset + 6,
  );
  const entriesOnDisk = readZipUint16(
    bytes,
    endOfCentralDirectoryOffset + 8,
  );
  const totalEntries = readZipUint16(
    bytes,
    endOfCentralDirectoryOffset + 10,
  );
  const centralDirectorySize = readZipUint32(
    bytes,
    endOfCentralDirectoryOffset + 12,
  );
  const centralDirectoryOffset = readZipUint32(
    bytes,
    endOfCentralDirectoryOffset + 16,
  );

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries < 1 ||
    totalEntries > MAX_OOXML_ENTRY_COUNT ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    centralDirectoryOffset + centralDirectorySize !==
      endOfCentralDirectoryOffset
  ) {
    throw invalidOfficePackageError();
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entryNames = new Set<string>();
  const normalizedEntryNames = new Set<string>();
  const nonEmptyFileNames = new Set<string>();
  const localEntryRanges: Array<{ start: number; end: number }> = [];
  const zipEntries: ValidatedZipEntry[] = [];
  let totalUncompressedBytes = 0;
  let centralOffset = centralDirectoryOffset;

  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    if (
      centralOffset + 46 > endOfCentralDirectoryOffset ||
      readZipUint32(bytes, centralOffset) !==
        ZIP_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw invalidOfficePackageError();
    }

    const generalPurposeFlags = readZipUint16(bytes, centralOffset + 8);
    const compressionMethod = readZipUint16(bytes, centralOffset + 10);
    const crc32 = readZipUint32(bytes, centralOffset + 16);
    const compressedSize = readZipUint32(bytes, centralOffset + 20);
    const uncompressedSize = readZipUint32(bytes, centralOffset + 24);
    const nameLength = readZipUint16(bytes, centralOffset + 28);
    const extraLength = readZipUint16(bytes, centralOffset + 30);
    const commentLength = readZipUint16(bytes, centralOffset + 32);
    const startingDisk = readZipUint16(bytes, centralOffset + 34);
    const localHeaderOffset = readZipUint32(bytes, centralOffset + 42);
    const nameOffset = centralOffset + 46;
    const extraOffset = nameOffset + nameLength;
    const nextCentralOffset = extraOffset + extraLength + commentLength;

    if (
      nextCentralOffset > endOfCentralDirectoryOffset ||
      (generalPurposeFlags & ~0x080e) !== 0 ||
      ![0, 8].includes(compressionMethod) ||
      (compressionMethod === 0 && compressedSize !== uncompressedSize) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      startingDisk !== 0 ||
      uncompressedSize > MAX_OOXML_ENTRY_UNCOMPRESSED_BYTES
    ) {
      throw invalidOfficePackageError();
    }

    validateZipExtraFields(bytes, extraOffset, extraLength);
    const name = decodeZipEntryName(
      bytes,
      nameOffset,
      nameLength,
      decoder,
    );
    const normalizedName = name.toLowerCase();
    if (
      entryNames.has(name) ||
      normalizedEntryNames.has(normalizedName) ||
      (name.endsWith("/") &&
        (compressedSize !== 0 || uncompressedSize !== 0)) ||
      isMacroOfficePart(name)
    ) {
      throw invalidOfficePackageError();
    }

    entryNames.add(name);
    normalizedEntryNames.add(normalizedName);
    if (!name.endsWith("/") && uncompressedSize > 0) {
      nonEmptyFileNames.add(name);
    }

    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_OOXML_TOTAL_UNCOMPRESSED_BYTES) {
      throw invalidOfficePackageError();
    }

    const localEntry = validateZipLocalEntry(
      bytes,
      nameOffset,
      nameLength,
      localHeaderOffset,
      centralDirectoryOffset,
      generalPurposeFlags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
    );
    localEntryRanges.push(localEntry);
    zipEntries.push({
      compressionMethod: compressionMethod as 0 | 8,
      crc32,
      uncompressedSize,
      dataOffset: localEntry.dataOffset,
      dataEndOffset: localEntry.dataEndOffset,
    });
    centralOffset = nextCentralOffset;
  }

  if (centralOffset !== endOfCentralDirectoryOffset) {
    throw invalidOfficePackageError();
  }

  localEntryRanges.sort((first, second) => first.start - second.start);
  if (
    localEntryRanges[0].start !== 0 ||
    localEntryRanges.at(-1)?.end !== centralDirectoryOffset
  ) {
    throw invalidOfficePackageError();
  }

  for (let index = 1; index < localEntryRanges.length; index += 1) {
    if (localEntryRanges[index - 1].end !== localEntryRanges[index].start) {
      throw invalidOfficePackageError();
    }
  }

  if (
    !nonEmptyFileNames.has("[Content_Types].xml") ||
    !nonEmptyFileNames.has("_rels/.rels") ||
    !nonEmptyFileNames.has(format.mainPart)
  ) {
    throw invalidOfficePackageError();
  }

  for (const entry of zipEntries) {
    await validateZipEntryContent(bytes, entry);
  }
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

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel(
            "pCloud content response exceeded the byte limit.",
          );
        } catch {
          // The size limit error below remains the relevant failure.
        }
        throw new PCloudContentLimitError(maxBytes);
      }

      chunks.push(value);
    }
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
  physicalPath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentUrl = await getPCloudFileContentUrl(env, physicalPath);
  const response = await fetchPCloudFileContent(contentUrl);
  validatePCloudContentResponse(response);
  return readResponseBytesWithinLimit(response, maxBytes);
}

async function readPCloudText(
  env: Env,
  physicalPath: string,
  maxBytes: number,
): Promise<{ text: string; byteLength: number }> {
  const bytes = await readPCloudFileBytes(env, physicalPath, maxBytes);
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
  entry: Record<string, unknown>,
  virtualPath?: string,
) {
  const isFolder = entry.isfolder === true;

  return {
    type: isFolder ? "folder" : "file",
    name: typeof entry.name === "string" ? entry.name : undefined,
    path:
      virtualPath ??
      (typeof entry.path === "string" ? entry.path : undefined),
    folderId:
      isFolder && entry.folderid !== undefined
        ? String(entry.folderid)
        : undefined,
    fileId:
      !isFolder && entry.fileid !== undefined ? String(entry.fileid) : undefined,
    size:
      !isFolder && typeof entry.size === "number" ? entry.size : undefined,
    modified:
      typeof entry.modified === "string" ? entry.modified : undefined,
    contentType:
      !isFolder && typeof entry.contenttype === "string"
        ? entry.contenttype
        : undefined,
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "pcloud-mcp-cloudflare",
    version: "0.0.0",
  });

  server.registerTool(
    "hello",
    {
      description: "Verify that the pCloud MCP Worker is running and reachable.",
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
      inputSchema: {
        folderId: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe(
            "pCloud folder ID. Disabled when PCLOUD_ROOT_PATH scopes the MCP to a subfolder. Prefer path.",
          ),
        path: z
          .string()
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
        if (folderId && path) {
          throw new Error("Specify either folderId or path, not both.");
        }

        const { rootPath } = getPCloudConfig(env);
        if (folderId && rootPath !== "/") {
          throw new Error(
            "folderId access is disabled because PCLOUD_ROOT_PATH scopes this MCP to a virtual root. Use a virtual path instead.",
          );
        }

        let params: Record<string, string>;
        let requestedVirtualPath: string | undefined;

        if (folderId) {
          params = { folderid: folderId };
        } else {
          const resolved = resolveVirtualPath(env, path);
          requestedVirtualPath = resolved.virtualPath;
          params = { path: resolved.physicalPath };
        }

        const data = await callPCloudJson(env, "listfolder", params);
        const folder = data.metadata ?? {};
        const contents = getMetadataContents(folder);
        const limit = maxEntries ?? 200;

        const entries = contents.slice(0, limit).map((entry) => {
          const name = typeof entry.name === "string" ? entry.name : undefined;
          const virtualEntryPath =
            requestedVirtualPath && name
              ? joinVirtualPath(requestedVirtualPath, name)
              : undefined;

          return compactPCloudEntry(entry, virtualEntryPath);
        });

        const folderPath =
          requestedVirtualPath ??
          (typeof folder.path === "string" ? folder.path : undefined);

        const result = {
          folder: {
            name:
              folderPath === "/"
                ? "/"
                : typeof folder.name === "string"
                  ? folder.name
                  : undefined,
            path: folderPath,
            folderId:
              folder.folderid !== undefined ? String(folder.folderid) : undefined,
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
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe("Substring to search for in names and relative virtual paths."),
        path: z
          .string()
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
        const needle = query.trim();
        if (!needle) {
          throw new Error("query must contain at least one non-whitespace character.");
        }

        const resolved = resolveVirtualPath(env, path);
        const data = await callPCloudJson(env, "listfolder", {
          path: resolved.physicalPath,
          recursive: "1",
        });

        const rootMetadata = data.metadata ?? {};
        const lowerNeedle = needle.toLocaleLowerCase();
        const returnFolders = includeFolders ?? true;
        const limit = maxResults ?? 50;
        const matches: ReturnType<typeof compactPCloudEntry>[] = [];
        let scannedEntries = 0;
        let totalMatches = 0;

        const visit = (
          entries: Array<Record<string, unknown>>,
          parentVirtualPath: string,
        ) => {
          for (const entry of entries) {
            scannedEntries += 1;

            const name = typeof entry.name === "string" ? entry.name : "";
            if (!name) {
              continue;
            }

            const virtualPath = joinVirtualPath(parentVirtualPath, name);
            const relativePath = relativeSearchPath(
              resolved.virtualPath,
              virtualPath,
            );
            const isFolder = entry.isfolder === true;
            const searchable = `${name}\n${relativePath}`.toLocaleLowerCase();
            const matchesQuery = searchable.includes(lowerNeedle);

            if (matchesQuery && (returnFolders || !isFolder)) {
              totalMatches += 1;
              if (matches.length < limit) {
                matches.push(compactPCloudEntry(entry, virtualPath));
              }
            }

            if (isFolder) {
              const children = getMetadataContents(entry);
              if (children.length > 0) {
                visit(children, virtualPath);
              }
            }
          }
        };

        visit(getMetadataContents(rootMetadata), resolved.virtualPath);

        const result = {
          query: needle,
          searchPath: resolved.virtualPath,
          includeFolders: returnFolders,
          matches,
          scannedEntries,
          totalMatches,
          returnedMatches: matches.length,
          truncated: totalMatches > matches.length,
          searchType: "metadata-name-and-path-substring",
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
      inputSchema: {
        path: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Required virtual absolute file path such as /Documents/example.md. File IDs are not accepted.",
          ),
      },
    },
    async ({ path }) => {
      try {
        const file = await statVirtualFile(env, path);
        const result = normalizeFileMetadata(
          file.metadata,
          file.virtualPath,
        );

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
      inputSchema: {
        path: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Required virtual absolute PNG or JPEG path. File IDs are not accepted.",
          ),
      },
    },
    async ({ path }) => {
      try {
        const file = await statVirtualFile(env, path);
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
      inputSchema: {
        path: z
          .string()
          .trim()
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
        const file = await statVirtualFile(env, path);
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
            file.physicalPath,
            allowedBytes,
          );
        } catch (error) {
          if (error instanceof PCloudContentLimitError) {
            throw new Error(
              `UTF-8 content for virtual path ${JSON.stringify(file.virtualPath)} exceeds the allowed maximum of ${error.allowedBytes} bytes.`,
            );
          }

          throw error;
        }

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
        "Return a DOCX, XLSX, or PPTX file as an MCP embedded binary resource after validating its exact virtual path, bounded OOXML package structure, and 1 MiB source-file limit. This tool is read-only.",
      inputSchema: {
        path: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Required virtual absolute DOCX, XLSX, or PPTX path. File IDs are not accepted.",
          ),
      },
    },
    async ({ path }) => {
      try {
        const file = await statVirtualFile(env, path);
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

        if (bytes.byteLength !== size) {
          throw new Error(
            "pCloud returned an incomplete or inconsistent Office file body.",
          );
        }

        await validateOfficePackage(bytes, format);
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

const jwksCache = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function normalizeTeamDomain(value: string): string {
  const raw = value.trim();
  const url = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`);
  return url.origin;
}

function getJwks(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${teamDomain}/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

async function verifyCloudflareAccess(
  request: Request,
  env: Env,
): Promise<boolean> {
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
    console.error(
      `Cloudflare Access validation is not configured. TEAM_DOMAIN=${Boolean(env.TEAM_DOMAIN)} POLICY_AUD=${Boolean(env.POLICY_AUD)}`,
    );
    return false;
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    console.warn("Cloudflare Access JWT header is missing.");
    return false;
  }

  try {
    const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
    await jwtVerify(token, getJwks(teamDomain), {
      issuer: teamDomain,
      audience: env.POLICY_AUD,
    });
    return true;
  } catch (error) {
    console.warn(
      "Cloudflare Access JWT verification failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return false;
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: McpExecutionContext,
  ): Promise<Response> {
    const authenticated = await verifyCloudflareAccess(request, env);
    if (!authenticated) {
      return new Response("Forbidden", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      const mcpHandler = createMcpHandler(() => createServer(env));
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
