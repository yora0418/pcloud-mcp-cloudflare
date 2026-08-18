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
  error?: string;
  metadata?: PCloudMetadata;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMetadataContents(
  metadata: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const contents = metadata.contents;
  return Array.isArray(contents) ? contents.filter(isRecord) : [];
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
