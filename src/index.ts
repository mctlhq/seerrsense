import { buildServer } from "./api/server.js";
import { config } from "./core/config.js";

async function start() {
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
