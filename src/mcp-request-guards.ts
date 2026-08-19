export const MCP_REQUEST_MAX_BYTES = 256 * 1024;

export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type McpRateLimitDecision = "allowed" | "limited" | "unavailable";

export class McpRequestBodyError extends Error {
  readonly status: 400 | 413;

  constructor(status: 400 | 413, message: string) {
    super(message);
    this.name = "McpRequestBodyError";
    this.status = status;
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

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel("MCP request body exceeded the byte limit.");
  } catch {
    // The bounded-ingress response remains the relevant failure.
  }
}

export async function createBoundedMcpRequest(
  request: Request,
  maxBytes = MCP_REQUEST_MAX_BYTES,
): Promise<Request> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = parseContentLength(contentLengthHeader);
    if (contentLength > maxBytes) {
      await cancelBody(request.body);
      throw new McpRequestBodyError(
        413,
        `MCP request body exceeds the ${maxBytes}-byte limit.`,
      );
    }
  }

  if (!request.body) {
    return request;
  }

  const reader = request.body.getReader();
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
          await reader.cancel("MCP request body exceeded the byte limit.");
        } catch {
          // The bounded-ingress response remains the relevant failure.
        }
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
    throw new McpRequestBodyError(400, "Unable to read the MCP request body.");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

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
  maxBytes = MCP_REQUEST_MAX_BYTES,
): Promise<T> {
  const boundedRequest = await createBoundedMcpRequest(request, maxBytes);
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
