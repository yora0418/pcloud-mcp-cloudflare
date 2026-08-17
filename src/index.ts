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
};

type PCloudJsonResponse = {
  result?: number | string;
  error?: string;
  metadata?: Record<string, unknown> & {
    contents?: Array<Record<string, unknown>>;
  };
};

const ALLOWED_PCLOUD_API_HOSTS = new Set([
  "api.pcloud.com",
  "eapi.pcloud.com",
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

function getPCloudConfig(env: Env) {
  if (!env.PCLOUD_ACCESS_TOKEN || !env.PCLOUD_API_HOST) {
    throw new Error(
      `pCloud is not configured. PCLOUD_ACCESS_TOKEN=${Boolean(env.PCLOUD_ACCESS_TOKEN)} PCLOUD_API_HOST=${Boolean(env.PCLOUD_API_HOST)}`,
    );
  }

  return {
    accessToken: env.PCLOUD_ACCESS_TOKEN,
    apiHost: normalizePCloudApiHost(env.PCLOUD_API_HOST),
  };
}

async function callPCloudJson(
  env: Env,
  method: string,
  params: Record<string, string>,
): Promise<PCloudJsonResponse> {
  const { accessToken, apiHost } = getPCloudConfig(env);
  const url = new URL(`https://${apiHost}/${method}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`pCloud HTTP error ${response.status}.`);
  }

  const data = (await response.json()) as PCloudJsonResponse;
  const result = Number(data.result ?? 0);

  if (!Number.isFinite(result) || result !== 0) {
    throw new Error(
      `pCloud API error ${String(data.result ?? "unknown")}: ${data.error ?? "Unknown pCloud error"}`,
    );
  }

  return data;
}

function compactPCloudEntry(entry: Record<string, unknown>) {
  const isFolder = entry.isfolder === true;

  return {
    type: isFolder ? "folder" : "file",
    name: typeof entry.name === "string" ? entry.name : undefined,
    path: typeof entry.path === "string" ? entry.path : undefined,
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
        "List files and folders in a pCloud folder. Defaults to the pCloud root folder. This tool is read-only.",
      inputSchema: {
        folderId: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("pCloud folder ID. Use either folderId or path, not both."),
        path: z
          .string()
          .optional()
          .describe("Absolute pCloud folder path such as /Documents. Use either path or folderId, not both."),
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

        if (path && (!path.startsWith("/") || (path.length > 1 && path.endsWith("/")))) {
          throw new Error(
            "pCloud paths must start with / and must not have a trailing slash.",
          );
        }

        const params: Record<string, string> = folderId
          ? { folderid: folderId }
          : path
            ? { path }
            : { folderid: "0" };

        const data = await callPCloudJson(env, "listfolder", params);
        const folder = data.metadata ?? {};
        const contents = Array.isArray(folder.contents) ? folder.contents : [];
        const limit = maxEntries ?? 200;
        const entries = contents.slice(0, limit).map(compactPCloudEntry);

        const result = {
          folder: {
            name: typeof folder.name === "string" ? folder.name : "/",
            path: typeof folder.path === "string" ? folder.path : undefined,
            folderId:
              folder.folderid !== undefined ? String(folder.folderid) : "0",
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
