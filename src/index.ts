import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
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
type McpEnv = Parameters<McpHandler>[1];
type McpExecutionContext = Parameters<McpHandler>[2];

export default {
  async fetch(
    request: Request,
    env: McpEnv,
    ctx: McpExecutionContext,
  ): Promise<Response> {
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
