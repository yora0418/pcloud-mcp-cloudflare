import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

function createServer() {
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

  return server;
}

const mcpHandler = createMcpHandler(createServer);

type McpHandler = typeof mcpHandler;
type McpBaseEnv = Parameters<McpHandler>[1];
type McpExecutionContext = Parameters<McpHandler>[2];

type Env = McpBaseEnv & {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
};

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
