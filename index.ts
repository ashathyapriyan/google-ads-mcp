import "dotenv/config";
import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";

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
    // Session store for SSE transport
    const sseTransports = new Map<string, SSEServerTransport>();
    // Session store for Streamable HTTP transport
    const httpTransports = new Map<string, StreamableHTTPServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
      // CORS — required for claude.ai and Claude Code
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Accept");
      res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── Health check ───────────────────────────────────────────────────────
      if (req.url === "/" || req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "google-ads-mcp-server" }));
        return;
      }

      // ── Streamable HTTP — for claude.ai (/mcp endpoint) ───────────────────
      if (req.url === "/mcp") {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              const parsed = JSON.parse(body);
              const sessionId = req.headers["mcp-session-id"] as string | undefined;

              // New session init
              if (!sessionId && isInitializeRequest(parsed)) {
                const newSessionId = randomUUID();
                const transport = new StreamableHTTPServerTransport({
                  sessionIdGenerator: () => newSessionId,
                  onsessioninitialized: (id) => {
                    httpTransports.set(id, transport);
                    console.log(`Streamable HTTP session started: ${id}`);
                  },
                });
                transport.onclose = () => {
                  httpTransports.delete(newSessionId);
                  console.log(`Streamable HTTP session closed: ${newSessionId}`);
                };
                const server = createMcpServer();
                await server.connect(transport);
                await transport.handleRequest(req, res, parsed);
                return;
              }

              // Existing session
              if (sessionId && httpTransports.has(sessionId)) {
                const transport = httpTransports.get(sessionId)!;
                await transport.handleRequest(req, res, parsed);
                return;
              }

              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Bad request: missing or invalid session" }));
            } catch (err) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }

        if (req.method === "GET") {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (sessionId && httpTransports.has(sessionId)) {
            const transport = httpTransports.get(sessionId)!;
            await transport.handleRequest(req, res);
            return;
          }
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid session ID" }));
          return;
        }

        if (req.method === "DELETE") {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (sessionId && httpTransports.has(sessionId)) {
            const transport = httpTransports.get(sessionId)!;
            await transport.handleRequest(req, res);
            httpTransports.delete(sessionId);
            return;
          }
          res.writeHead(404);
          res.end();
          return;
        }
      }

      // ── SSE — for Claude Code (/sse endpoint) ─────────────────────────────
      if (req.url === "/sse" && req.method === "GET") {
        const server = createMcpServer();
        const transport = new SSEServerTransport("/messages", res);
        sseTransports.set(transport.sessionId, transport);
        res.on("close", () => {
          sseTransports.delete(transport.sessionId);
          console.log(`SSE client disconnected: ${transport.sessionId}`);
        });
        await server.connect(transport);
        console.log(`SSE client connected: ${transport.sessionId}`);
        return;
      }

      if (req.url?.startsWith("/messages") && req.method === "POST") {
        const url = new URL(req.url, `http://localhost`);
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const transport = sseTransports.get(sessionId);
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
      console.log(`✅ Google Ads MCP Server running on port ${port}`);
      console.log(`   claude.ai  → /mcp  (Streamable HTTP)`);
      console.log(`   Claude Code→ /sse  (SSE)`);
      console.log(`   Health     → /health`);
    });

  } else {
    // ── Stdio mode (local Claude Code) ──────────────────────────────────────
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
