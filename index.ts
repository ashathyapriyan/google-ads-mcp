import "dotenv/config";
import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { loadConfig } from "./services/google-ads-client.js";
import { registerCampaignTools } from "./tools/campaigns.js";
import { registerKeywordTools } from "./tools/keywords.js";
import { registerAdTools } from "./tools/ads.js";
import { registerReportTools } from "./tools/reports.js";
import type { GoogleAdsConfig } from "./types.js";

// ─── Server Factory ───────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "google-ads-mcp-server",
    version: "1.0.0",
  });

  let _config: GoogleAdsConfig | null = null;
  function getConfig(): GoogleAdsConfig {
    if (!_config) _config = loadConfig();
    return _config;
  }

  registerCampaignTools(server, getConfig);
  registerKeywordTools(server, getConfig);
  registerAdTools(server, getConfig);
  registerReportTools(server, getConfig);

  return server;
}

// ─── Transport ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const port = process.env.PORT;

  if (port) {
    // ── HTTP / SSE mode (Railway, Render, etc.) ────────────────────────────
    const transports = new Map<string, SSEServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
      // CORS headers so Claude Code can connect from anywhere
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check
      if (req.url === "/" || req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "google-ads-mcp-server" }));
        return;
      }

      // SSE endpoint — Claude Code connects here
      if (req.url === "/sse" && req.method === "GET") {
        const server = createMcpServer();
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        res.on("close", () => {
          transports.delete(transport.sessionId);
          console.log(`Client disconnected: ${transport.sessionId}`);
        });
        await server.connect(transport);
        console.log(`Client connected: ${transport.sessionId}`);
        return;
      }

      // Message endpoint — receives tool calls from Claude Code
      if (req.url?.startsWith("/messages") && req.method === "POST") {
        const url = new URL(req.url, `http://localhost`);
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const transport = transports.get(sessionId);

        if (!transport) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            await transport.handlePostMessage(req, res, JSON.parse(body));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.listen(Number(port), () => {
      console.log(`✅ Google Ads MCP Server running on port ${port} (SSE)`);
      console.log(`   SSE endpoint: http://localhost:${port}/sse`);
      console.log(`   Health check: http://localhost:${port}/health`);
    });

  } else {
    // ── Stdio mode (local Claude Code) ────────────────────────────────────
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("✅ Google Ads MCP Server running (stdio)");
  }
}

main().catch((error: unknown) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
