export const MCP_REQUEST_MAX_BYTES = 256 * 1024;

export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type McpRateLimitDecision = "allowed" | "limited" | "unavailable";

export class McpRequestBodyError extends Error {
  readonly status: 400 | 408 | 413;

  constructor(status: 400 | 408 | 413, message: string) {
    super(message);
    this.name = "McpRequestBodyError";
    this.status = status;
  }
}

export type McpRequestGuardOptions = {
  maxBytes?: number;
  deadlineAt?: number;
};

class McpRequestReadCanceledError extends Error {
  constructor() {
    super("MCP request body read was canceled.");
    this.name = "McpRequestReadCanceledError";
  }
}

const MCP_REQUEST_CANCELED_MESSAGE =
  "MCP request was canceled or exceeded its deadline.";

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function rejectJsonRpcBatch(bytes: Uint8Array): void {
  let offset =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? 3
      : 0;

  while (offset < bytes.length && isJsonWhitespace(bytes[offset])) {
    offset += 1;
  }

  if (bytes[offset] === 0x5b) {
    throw new McpRequestBodyError(
      400,
      "JSON-RPC batch requests are not supported.",
    );
  }
}

function parseContentLength(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new McpRequestBodyError(400, "Invalid Content-Length header.");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new McpRequestBodyError(400, "Invalid Content-Length header.");
  }

  return parsed;
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
  reason: string,
): Promise<void> {
  try {
    await body?.cancel(reason);
  } catch {
    // The bounded-ingress response remains the relevant failure.
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // The bounded-ingress response remains the relevant failure.
  }
}

function createBodyReadSignal(
  requestSignal: AbortSignal,
  deadlineAt: number | undefined,
): AbortSignal {
  if (deadlineAt === undefined) {
    return requestSignal;
  }

  const remainingMs = deadlineAt - Date.now();
  if (requestSignal.aborted || remainingMs <= 0) {
    return AbortSignal.abort();
  }

  return AbortSignal.any([
    requestSignal,
    AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs))),
  ]);
}

export async function createBoundedMcpRequest(
  request: Request,
  options: McpRequestGuardOptions = {},
): Promise<Request> {
  const maxBytes = options.maxBytes ?? MCP_REQUEST_MAX_BYTES;
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = parseContentLength(contentLengthHeader);
    if (contentLength > maxBytes) {
      await cancelBody(
        request.body,
        "MCP request body exceeded the byte limit.",
      );
      throw new McpRequestBodyError(
        413,
        `MCP request body exceeds the ${maxBytes}-byte limit.`,
      );
    }
  }

  const readSignal = createBodyReadSignal(
    request.signal,
    options.deadlineAt,
  );
  if (readSignal.aborted) {
    await cancelBody(request.body, MCP_REQUEST_CANCELED_MESSAGE);
    throw new McpRequestBodyError(408, MCP_REQUEST_CANCELED_MESSAGE);
  }

  if (!request.body) {
    return request;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new McpRequestReadCanceledError());
    if (readSignal.aborted) {
      abortListener();
    } else {
      readSignal.addEventListener("abort", abortListener, { once: true });
    }
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        abortPromise,
      ]);
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await cancelReader(
          reader,
          "MCP request body exceeded the byte limit.",
        );
        throw new McpRequestBodyError(
          413,
          `MCP request body exceeds the ${maxBytes}-byte limit.`,
        );
      }

      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof McpRequestBodyError) {
      throw error;
    }
    if (error instanceof McpRequestReadCanceledError || readSignal.aborted) {
      await cancelReader(reader, MCP_REQUEST_CANCELED_MESSAGE);
      throw new McpRequestBodyError(408, MCP_REQUEST_CANCELED_MESSAGE);
    }
    throw new McpRequestBodyError(400, "Unable to read the MCP request body.");
  } finally {
    if (abortListener) {
      readSignal.removeEventListener("abort", abortListener);
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  rejectJsonRpcBatch(bytes);

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");

  try {
    return new Request(request, {
      headers,
      body: bytes,
    });
  } catch {
    throw new McpRequestBodyError(400, "Unable to read the MCP request body.");
  }
}

export async function dispatchBoundedMcpRequest<T>(
  request: Request,
  dispatch: (boundedRequest: Request) => T | Promise<T>,
  options: McpRequestGuardOptions = {},
): Promise<T> {
  const boundedRequest = await createBoundedMcpRequest(request, options);
  return dispatch(boundedRequest);
}

export async function checkMcpRateLimit(
  binding: RateLimitBinding | undefined,
  key: string,
): Promise<McpRateLimitDecision> {
  if (!binding) {
    return "unavailable";
  }

  try {
    const outcome = await binding.limit({ key });
    if (typeof outcome?.success !== "boolean") {
      return "unavailable";
    }
    return outcome.success ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}
