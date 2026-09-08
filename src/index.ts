import { buildServer } from "./api/server.js";
import { config } from "./core/config.js";
import { createSeerrSenseMcpServer } from "./mcp/server.js";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

async function start() {
  const args = process.argv.slice(2);

  if (args.includes("stdio") || args.includes("--stdio")) {
    // BYO-MCP mode for Claude Desktop / Antigravity etc. serveStdio owns the
    // transport and serves both 2025-era and modern protocol revisions from
    // the same factory. Never write to stdout here: it is the JSON-RPC channel.
    serveStdio(() => createSeerrSenseMcpServer(), {
      onerror: (err) => console.error("SeerrSense stdio error:", err),
    });
    console.error("SeerrSense MCP Server running on stdio");
    return;
  }

  const server = buildServer();
  try {
    await server.listen({ port: config.PORT, host: "0.0.0.0" });
    server.log.info(`SeerrSense is running on http://0.0.0.0:${config.PORT}`);
    server.log.info(`MCP Server available at http://0.0.0.0:${config.PORT}/mcp`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
