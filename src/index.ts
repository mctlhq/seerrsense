import { buildServer } from "./api/server.js";
import { config } from "./core/config.js";
import { createSeerrSenseMcpServer } from "./mcp/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function start() {
  const args = process.argv.slice(2);
  
  if (args.includes("stdio") || args.includes("--stdio")) {
    const mcpServer = createSeerrSenseMcpServer();
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error("SeerrSense MCP Server running on stdio");
  } else {
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
}

start();
