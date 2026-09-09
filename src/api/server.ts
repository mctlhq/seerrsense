import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
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
import { redeemAuthorizationCode, registerOAuthRoutes } from "../auth/routes.js";
import { MemoryAuthStore, type AuthStore } from "../auth/store.js";
import { PostgresAuthStore } from "../auth/store-pg.js";
import { authenticate, UnauthorizedError, wwwAuthenticate } from "../auth/verifier.js";
import { registerAccountRoutes } from "./account.js";
import { issueSession, SESSION_COOKIE } from "../auth/session.js";

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
  // The account page and the browser leg of its sign-in. The page itself
  // carries no data; everything it shows comes from /api/v1/account/*, which
  // is gated on the session cookie.
  "/account",
  "/account/callback",
  "/privacy",
  "/terms",
  // The browser has no token yet when it finishes its own PKCE exchange here;
  // the route is guarded by the authorization code and verifier it must present.
  "/account/session",
];

/**
 * Routes that skip the bearer gate because they authenticate themselves, with
 * the browser session cookie. They are not public: every handler under this
 * prefix refuses a request without a valid session, and deliberately does not
 * accept an MCP access token — an assistant must not be able to read or rewrite
 * which Seerr it talks to.
 */
const SESSION_PREFIXES = ["/api/v1/account/"];

function isPublic(url: string): boolean {
  // Match on the path only: "/healthz?x=1" is the same route, and the previous
  // exact-equality check refused it.
  const path = url.split("?")[0];
  return PUBLIC_PREFIXES.some((prefix) =>
    // "/" is the landing page itself, not a prefix for every route below it.
    prefix.endsWith("/") && prefix !== "/" ? path.startsWith(prefix) : path === prefix,
  );
}

function isSessionRoute(url: string): boolean {
  const path = url.split("?")[0];
  return SESSION_PREFIXES.some((prefix) => path.startsWith(prefix));
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
    const oauth = authSettings.oauth;
    fastify.register(fastifyCookie);
    registerOAuthRoutes(fastify, oauth, authStore, { fetchImpl: deps.fetchImpl });
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
    if (isPublic(request.url) || isSessionRoute(request.url)) return;

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
  // cacheControl:false so the plugin does not stamp its own header over the
  // one that matters here: this page is per-person and must not be cached.
  fastify.get("/account", async (_request, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .sendFile("account.html", { cacheControl: false }),
  );
  // Required by Google before an OAuth app can be published, and independently
  // right for a service that stores other people's credentials.
  fastify.get("/privacy", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").sendFile("privacy.html"),
  );
  fastify.get("/terms", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").sendFile("terms.html"),
  );
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

  if (authSettings.oauth && authStore) {
    const oauth = authSettings.oauth;
    registerAccountRoutes(fastify, oauth, authStore, tenants);

    // The page finishes its own PKCE exchange here rather than in JavaScript:
    // the browser gets a session cookie scoped to the account API, and no MCP
    // access token is ever handed to page script.
    fastify.get("/account/callback", async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      if (query.error) {
        return reply.type("text/html; charset=utf-8").status(400).send(
          `<p>Sign-in was refused: ${String(query.error).replace(/[<&>]/g, "")}</p>`,
        );
      }
      // The verifier lives in the page, so the page posts the code back to
      // itself; this route only serves the shell that does that.
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .sendFile("account-callback.html", { cacheControl: false });
    });

    fastify.post("/account/session", async (request, reply) => {
      const body = (request.body ?? {}) as { code?: string; codeVerifier?: string };
      if (!body.code || !body.codeVerifier) {
        return reply.status(400).send({ error: "code and codeVerifier are required" });
      }
      // Redeemed in process. Calling our own token endpoint over HTTP would put
      // the reverse proxy and our own public hostname on the critical path of a
      // sign-in, to reach code that is right here.
      const redeemed = await redeemAuthorizationCode(authStore, {
        code: body.code,
        codeVerifier: body.codeVerifier,
        redirectUri: `${oauth.issuer}/account/callback`,
        clientId: `${oauth.issuer}/account`,
      });
      if (!redeemed.ok) {
        request.log.info({ reason: redeemed.description }, "account sign-in refused");
        return reply.status(400).send({ error: "that sign-in could not be completed" });
      }

      const session = await issueSession(
        { subject: redeemed.grant.subject, email: redeemed.grant.email },
        oauth.signingKey,
        oauth.issuer,
      );
      return reply
        .setCookie(SESSION_COOKIE, session.value, {
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          secure: oauth.issuer.startsWith("https://"),
          maxAge: session.maxAge,
        })
        .send({ ok: true });
    });
  }

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
  // The factory runs per request and resolves the tenant from the same
  // AuthInfo the preHandler validated. It deliberately does not read the tenant
  // the preHandler attached to request.raw: ctx.requestInfo is a WHATWG Request
  // built from the Node request, not the Node request itself, so a property
  // hung off request.raw is simply not there and every caller would silently
  // look unconnected. Resolution is cached per subject, so this costs no extra
  // database read on the hot path.
  const handler = createMcpHandler(async (ctx) =>
    createSeerrSenseMcpServer(ctx.authInfo?.scopes, await tenants.resolve(ctx.authInfo)),
  );
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
