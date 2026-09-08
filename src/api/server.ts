import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import Fastify from "fastify";
import { createSeerrSenseMcpServer } from "../mcp/server.js";
import { seerrClient } from "../providers/seerr/client.js";
import { MediaParamsSchema, RequestBodySchema } from "../core/media.js";
import { assertHttpConfig, config as rawConfig } from "../core/config.js";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { MediaRequestService } from "./service.js";
import { MediaResolver } from "./resolver/index.js";
import { NebiusIntentExtractor } from "./resolver/intent.js";
import { z } from "zod";

const SearchQuerySchema = z.object({ query: z.string().min(1) });

export function buildServer() {
  const config = assertHttpConfig(rawConfig);
  // We use createMcpFastifyApp for host/dns rebinding protection as recommended
  const fastify = createMcpFastifyApp({ host: "0.0.0.0" });
  const mediaService = new MediaRequestService();

  // Auth preHandler
  fastify.addHook("preHandler", async (request, reply) => {
    // Skip auth for health/ready
    if (request.url === "/health" || request.url === "/ready" || request.url === "/healthz" || request.url === "/readyz") return;
    
    // Check Authorization header against required config token
    const expectedToken = config.SEERRSENSE_AUTH_TOKEN;
    const authHeader = request.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
       return reply.status(401).send({ error: "Unauthorized" });
    }
  });

  fastify.get("/health", async () => {
    return { status: "ok" };
  });
  
  fastify.get("/healthz", async () => {
    return { status: "ok" };
  });

  fastify.get("/ready", async (request, reply) => {
    return { status: "ready" };
  });

  fastify.get("/readyz", async (request, reply) => {
    // For MCTL Kubernetes probes, we return 200 immediately. 
    // If we strictly check seerrClient.status() here and the API key is missing/dummy, 
    // the probe will fail (503) and the pod will never become ready to receive traffic.
    return { status: "ready" };
  });

  fastify.get("/api/v1/search", async (request, reply) => {
    const q = SearchQuerySchema.safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: "Missing or invalid query parameter" });
    }
    return seerrClient.search(q.data.query);
  });

  fastify.get("/api/v1/media/:mediaType/:tmdbId", async (request, reply) => {
    const params = MediaParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues });
    }
    return seerrClient.getMedia(params.data.mediaType, params.data.tmdbId);
  });

  fastify.post("/api/v1/request", async (request, reply) => {
    const body = RequestBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues });
    }
    try {
       const result = await mediaService.requestMediaSafely(body.data);
       return result;
    } catch (err: any) {
       return reply.status(400).send({ error: err.message });
    }
  });

  // MCP v2 Protocol 2026-07-28 compliant Streamable HTTP endpoint
  const handler = createMcpHandler(() => createSeerrSenseMcpServer());
  const nodeHandler = toNodeHandler(handler);

  fastify.all("/mcp", async (request, reply) => {
    await nodeHandler(request.raw, reply.raw, request.body);
  });

  let intentExtractor;
  if (config.NEBIUS_API_KEY) {
    intentExtractor = new NebiusIntentExtractor();
  }
  const mediaResolver = new MediaResolver(seerrClient, intentExtractor);

  fastify.get("/api/v1/resolve", async (request, reply) => {
    const q = SearchQuerySchema.safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: "Missing or invalid query parameter" });
    }
    
    try {
      const result = await mediaResolver.resolveMedia(q.data.query);
      return reply.send(result);
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  return fastify;
}
