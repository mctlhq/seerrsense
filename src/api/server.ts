import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { createSeerrSenseMcpServer } from "../mcp/server.js";
import { createDefaultSeerrClient } from "../providers/seerr/client.js";
import { notConnectedMessage, TenantResolver, type Tenant } from "../providers/seerr/tenants.js";
import { MediaParamsSchema, RequestBodySchema } from "../core/media.js";
import { assertHttpConfig, config as rawConfig } from "../core/config.js";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { MediaRequestService } from "./service.js";
import { MediaResolver } from "./resolver/index.js";
import { NebiusIntentExtractor } from "./resolver/intent.js";
import { z } from "zod";
import { loadAuthSettings, SCOPE_READ } from "../auth/config.js";
import { registerOAuthRoutes } from "../auth/routes.js";
import { MemoryAuthStore, type AuthStore } from "../auth/store.js";
import { PostgresAuthStore } from "../auth/store-pg.js";
import { authenticate, UnauthorizedError, wwwAuthenticate } from "../auth/verifier.js";

const SearchQuerySchema = z.object({ query: z.string().min(1) });

/**
 * Served without a token: probes, the OAuth flow and its discovery documents,
 * and the public web surface the landing page (#6) will occupy. Listing the
 * web paths now means the landing page is a matter of serving files rather than
 * also reopening the auth gate; until it exists they simply 404.
 */
const PUBLIC_PREFIXES = [
  "/health",
  "/healthz",
  "/ready",
  "/readyz",
  "/.well-known/",
  "/oauth/",
  "/",
  "/favicon.svg",
  "/favicon.ico",
  "/og.png",
  "/assets/",
];

function isPublic(url: string): boolean {
  // Match on the path only: "/healthz?x=1" is the same route, and the previous
  // exact-equality check refused it.
  const path = url.split("?")[0];
  return PUBLIC_PREFIXES.some((prefix) =>
    // "/" is the landing page itself, not a prefix for every route below it.
    prefix.endsWith("/") && prefix !== "/" ? path.startsWith(prefix) : path === prefix,
  );
}

export function buildServer(deps: { store?: AuthStore; fetchImpl?: typeof fetch } = {}) {
  const config = assertHttpConfig(rawConfig);
  const authSettings = loadAuthSettings(process.env, config.SEERRSENSE_AUTH_TOKEN);
  if (!authSettings.oauth && !authSettings.legacyToken) {
    throw new Error(
      "the HTTP server has no way to authenticate: configure OAuth or leave SEERRSENSE_AUTH_TOKEN enabled",
    );
  }
  // We use createMcpFastifyApp for host/dns rebinding protection as recommended
  const fastify = createMcpFastifyApp({ host: "0.0.0.0" });

  const authStore: AuthStore | undefined = authSettings.oauth
    ? (deps.store ?? (authSettings.oauth.databaseUrl
        ? new PostgresAuthStore(authSettings.oauth.databaseUrl)
        : new MemoryAuthStore()))
    : undefined;

  if (authSettings.oauth && authStore) {
    registerOAuthRoutes(fastify, authSettings.oauth, authStore, { fetchImpl: deps.fetchImpl });
    // Expired rows are ignored on read, but nothing deletes them, so a
    // long-lived database would grow without bound. unref so the sweep never
    // holds the process open.
    let purgeTimer: NodeJS.Timeout | undefined;
    fastify.addHook("onReady", async () => {
      await authStore.init();
      await authStore.purgeExpired();
      purgeTimer = setInterval(() => {
        authStore.purgeExpired().catch((error) => fastify.log.warn({ err: error }, "OAuth purge failed"));
      }, 60 * 60 * 1000);
      purgeTimer.unref();
    });
    fastify.addHook("onClose", async () => {
      if (purgeTimer) clearInterval(purgeTimer);
      await authStore.close();
    });
  }

  const tenants = new TenantResolver(
    authStore,
    authSettings.oauth?.encryptionKey,
    createDefaultSeerrClient(),
  );

  /** The Seerr resolved for this request, attached by the auth hook. */
  const tenantOf = (request: { raw: unknown }): Tenant | undefined =>
    (request.raw as { tenant?: Tenant }).tenant;

  fastify.addHook("preHandler", async (request, reply) => {
    if (isPublic(request.url)) return;

    let auth: AuthInfo;
    try {
      auth = await authenticate(authSettings, request.headers.authorization);
    } catch (error) {
      const scheme = request.headers.authorization?.split(" ")[0]?.toLowerCase();
      const code = scheme && scheme !== "bearer" ? "invalid_request" : "invalid_token";
      // The challenge is what makes an MCP client start the OAuth flow instead
      // of simply failing, so it goes on every rejection.
      return reply
        .header("www-authenticate", wwwAuthenticate(authSettings, code))
        .status(401)
        .send({
          error: "invalid_token",
          error_description: error instanceof UnauthorizedError ? error.message : "unauthorized",
        });
    }

    if (!auth.scopes.includes(SCOPE_READ)) {
      return reply
        .header("www-authenticate", wwwAuthenticate(authSettings, "invalid_token"))
        .status(403)
        .send({ error: "insufficient_scope", error_description: `${SCOPE_READ} is required` });
    }

    // toNodeHandler forwards req.auth to the MCP handler as authInfo, which the
    // server factory reads to scope the write tool.
    (request.raw as { auth?: AuthInfo }).auth = auth;
    // Which Seerr this caller reaches. Resolved once per request and cached by
    // subject, so the MCP hot path keeps its "no database read" property.
    (request.raw as { tenant?: Tenant }).tenant = await tenants.resolve(auth);
  });

  // The landing page: three explicit routes plus one prefixed asset directory.
  // The first registration passes `serve: false`, so it adds no routes and only
  // lends reply.sendFile the public root — there is no wildcard at "/" that
  // could serve files by name or shadow a route added later. This is not a
  // single-page app: a path that is not declared here is not answered with the
  // page. It meets the auth gate instead and is refused, since everything
  // outside PUBLIC_PREFIXES needs a token.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
  fastify.register(fastifyStatic, { root: publicDir, serve: false });
  fastify.register(fastifyStatic, {
    root: join(publicDir, "assets"),
    prefix: "/assets/",
    decorateReply: false,
    index: false,
    // Asset URLs are not fingerprinted, so a long cache would let a browser
    // pair a freshly deployed page with the previous stylesheet. Five minutes
    // is enough to spare the repeat requests and short enough that a rollout
    // heals itself; the files are a few kilobytes.
    cacheControl: true,
    maxAge: 300_000,
  });

  fastify.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").sendFile("index.html"));
  fastify.get("/favicon.svg", async (_request, reply) => reply.type("image/svg+xml").sendFile("favicon.svg"));
  fastify.get("/og.png", async (_request, reply) => reply.type("image/png").sendFile("og.png"));

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
    const tenant = tenantOf(request);
    if (!tenant?.client) {
      return reply.status(409).send({ error: notConnectedMessage(config.SEERRSENSE_PUBLIC_URL) });
    }
    return tenant.client.search(q.data.query);
  });

  fastify.get("/api/v1/media/:mediaType/:tmdbId", async (request, reply) => {
    const params = MediaParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues });
    }
    const tenant = tenantOf(request);
    if (!tenant?.client) {
      return reply.status(409).send({ error: notConnectedMessage(config.SEERRSENSE_PUBLIC_URL) });
    }
    return tenant.client.getMedia(params.data.mediaType, params.data.tmdbId);
  });

  fastify.post("/api/v1/request", async (request, reply) => {
    const body = RequestBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues });
    }
    const tenant = tenantOf(request);
    if (!tenant?.client) {
      return reply.status(409).send({ error: notConnectedMessage(config.SEERRSENSE_PUBLIC_URL) });
    }
    try {
       const service = new MediaRequestService(tenant.client, tenant.attributedUserId);
       const result = await service.requestMediaSafely(body.data);
       return result;
    } catch (err: any) {
       return reply.status(400).send({ error: err.message });
    }
  });

  // MCP v2 Protocol 2026-07-28 compliant Streamable HTTP endpoint
  // The factory runs per request and reads both the granted scopes and the
  // resolved tenant off the same request object.
  const handler = createMcpHandler((ctx) => {
    const raw = ctx.requestInfo as unknown as { tenant?: Tenant } | undefined;
    return createSeerrSenseMcpServer(ctx.authInfo?.scopes, raw?.tenant);
  });
  const nodeHandler = toNodeHandler(handler);

  fastify.all("/mcp", async (request, reply) => {
    await nodeHandler(request.raw, reply.raw, request.body);
  });

  const intentExtractor = config.NEBIUS_API_KEY ? new NebiusIntentExtractor() : undefined;

  fastify.get("/api/v1/resolve", async (request, reply) => {
    const q = SearchQuerySchema.safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({ error: "Missing or invalid query parameter" });
    }
    
    const tenant = tenantOf(request);
    if (!tenant?.client) {
      return reply.status(409).send({ error: notConnectedMessage(config.SEERRSENSE_PUBLIC_URL) });
    }
    try {
      const mediaResolver = new MediaResolver(tenant.client, intentExtractor);
      const result = await mediaResolver.resolveMedia(q.data.query);
      return reply.send(result);
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });

  return fastify;
}
