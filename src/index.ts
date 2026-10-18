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

  // The image starts node as PID 1, and PID 1 gets no default SIGTERM action:
  // without a handler the pod sits out its whole grace period and is killed.
  // Close lets in-flight requests finish; the timer covers a client that holds
  // a stream open past the kubelet's patience.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      server.log.info(`Shutting down on ${signal}`);
      setTimeout(() => process.exit(1), 10_000).unref();
      server.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

start();
