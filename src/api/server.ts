import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import { createSeerrSenseMcpServer } from "../mcp/server.js";
import { createDefaultSeerrClient } from "../providers/seerr/client.js";
import { notConnectedMessage, TenantResolver, type Tenant } from "../providers/seerr/tenants.js";
import { MediaParamsSchema, RequestBodySchema } from "../core/media.js";
import { assertHttpConfig, config as rawConfig } from "../core/config.js";
import { MediaRequestService } from "./service.js";
import { MediaResolver } from "./resolver/index.js";
import { NebiusIntentExtractor, type IntentExtractor } from "./resolver/intent.js";
import { BudgetedIntentExtractor, ResolveBudgetError } from "./resolver/budget.js";
import { z } from "zod";
import { loadAuthSettings, SCOPE_READ } from "../auth/config.js";
import { redeemAuthorizationCode, registerOAuthRoutes } from "../auth/routes.js";
import { MemoryAuthStore, type AuthStore } from "../auth/store.js";
import { PostgresAuthStore } from "../auth/store-pg.js";
import { authenticate, UnauthorizedError, wwwAuthenticate } from "../auth/verifier.js";
import { registerAccountRoutes } from "./account.js";
import { issueSession, SESSION_COOKIE } from "../auth/session.js";
import rateLimit from "@fastify/rate-limit";

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

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Every window/ceiling here is retunable in gitops without a release. */
function rateLimitSettings() {
  return {
    // 10 requests / 5 min per IP.
    oauth: {
      max: envInt("SEERRSENSE_RATE_LIMIT_OAUTH_MAX", 10),
      timeWindow: envInt("SEERRSENSE_RATE_LIMIT_OAUTH_WINDOW_MS", 5 * 60 * 1000),
    },
    // 5 / 5 min per IP: each call dials an arbitrary host.
    connection: {
      max: envInt("SEERRSENSE_RATE_LIMIT_CONNECTION_MAX", 5),
      timeWindow: envInt("SEERRSENSE_RATE_LIMIT_CONNECTION_WINDOW_MS", 5 * 60 * 1000),
    },
    // 120 / min per subject on /mcp and /api/v1/*, falling back to IP.
    subject: {
      max: envInt("SEERRSENSE_RATE_LIMIT_SUBJECT_MAX", 120),
      timeWindow: envInt("SEERRSENSE_RATE_LIMIT_SUBJECT_WINDOW_MS", 60 * 1000),
    },
  };
}

function resolveBudgetSettings() {
  return {
    dailyLimit: envInt("SEERRSENSE_RESOLVE_DAILY_LIMIT", 50),
    globalDailyLimit: envInt("SEERRSENSE_RESOLVE_GLOBAL_DAILY_LIMIT", 2000),
  };
}

function subjectOf(request: { raw: unknown }): string | undefined {
  const auth = (request.raw as { auth?: AuthInfo }).auth;
  return typeof auth?.extra?.subject === "string" ? auth.extra.subject : undefined;
}

function ipRateLimited(rateLimit: { max: number; timeWindow: number }, routeName: string) {
  return {
    config: {
      rateLimit: {
        max: rateLimit.max,
        timeWindow: rateLimit.timeWindow,
        keyGenerator: (req: FastifyRequest) => req.ip,
        onExceeded: (req: FastifyRequest) => {
          req.log.warn({ route: routeName, key: "ip" }, "rate limit exceeded");
        },
      },
    },
  };
}

/** Per-subject on an authenticated route, falling back to IP when there is
 * no subject — a request that never reached the bearer preHandler, or the
 * legacy shared token / stdio path, which has no OAuth subject at all. */
function subjectRateLimited(rateLimit: { max: number; timeWindow: number }, routeName: string) {
  return {
    config: {
      rateLimit: {
        max: rateLimit.max,
        timeWindow: rateLimit.timeWindow,
        keyGenerator: (req: FastifyRequest) => subjectOf(req) ?? req.ip,
        onExceeded: (req: FastifyRequest) => {
          req.log.warn(
            { route: routeName, key: subjectOf(req) ? "subject" : "ip" },
            "rate limit exceeded",
          );
        },
      },
    },
  };
}

export function buildServer(
  deps: {
    store?: AuthStore;
    fetchImpl?: typeof fetch;
    /** Injectable for tests: stands in for the SSRF guard's DNS lookup. */
    lookup?: (host: string) => Promise<string[]>;
  } = {},
) {
  const config = assertHttpConfig(rawConfig);
  const authSettings = loadAuthSettings(process.env, config.SEERRSENSE_AUTH_TOKEN);
  if (!authSettings.oauth && !authSettings.legacyToken) {
    throw new Error(
      "the HTTP server has no way to authenticate: configure OAuth or leave SEERRSENSE_AUTH_TOKEN enabled",
    );
  }
  // createMcpFastifyApp does not forward Fastify constructor options (only
  // host/allowedHosts/allowedOrigins, used to decide whether to add DNS
  // rebinding hooks) — confirmed by reading its source rather than assuming
  // it. At host "0.0.0.0" it adds no rebinding hook either way, only a log
  // warning, so building Fastify directly here for host "0.0.0.0" carries no
  // loss of the protection createMcpFastifyApp would have applied.
  const fastify = Fastify({
    trustProxy: true,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-api-key']",
          "*.apiKey",
          "*.seerrApiKeySealed",
          "*.cfAccessClientSecret",
        ],
        remove: true,
      },
    },
  });

  // global: false means every route opts in individually via
  // `config.rateLimit`; hook: "preHandler" so the subject the global auth
  // preHandler resolves below is already on request.raw by the time a
  // route's own key generator runs. Health probes and /assets/* are simply
  // never given a rateLimit config, so they stay unlimited.
  fastify.register(rateLimit, { global: false, hook: "preHandler" });
  const limits = rateLimitSettings();

  const authStore: AuthStore | undefined = authSettings.oauth
    ? (deps.store ?? (authSettings.oauth.databaseUrl
        ? new PostgresAuthStore(authSettings.oauth.databaseUrl)
        : new MemoryAuthStore()))
    : undefined;

  const tenants = new TenantResolver(
    authStore,
    authSettings.oauth?.encryptionKey,
    createDefaultSeerrClient(),
    authSettings.oauth?.householdEmails,
    60_000,
    deps.lookup,
  );

  /** The Seerr resolved for this request, attached by the auth hook. */
  const tenantOf = (request: { raw: unknown }): Tenant | undefined =>
    (request.raw as { tenant?: Tenant }).tenant;

  // Registered on the root instance (not inside the nested plugin below) on
  // purpose: Fastify's default not-found handler runs through whichever
  // onRequest/preHandler hooks are present at the ROOT level at boot time, so
  // an undeclared path still meets this gate and answers 401 rather than
  // leaking a 404 that would tell an unauthenticated caller a route exists.
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

  // Fastify only wires a plugin's `onRoute` hook (which is how
  // `config.rateLimit` gets attached below) into routes registered *after*
  // that plugin has finished loading — `register()` defers execution to the
  // boot sequence, while a bare `fastify.get(...)` call adds the route
  // immediately. Every route is therefore registered inside this nested
  // plugin, which avvio boots strictly after the rate-limit plugin above
  // rather than at the top level; hooks added on the root instance (the auth
  // gate above) still apply to routes registered in here.
  fastify.register(async (fastify) => {
  if (authSettings.oauth && authStore) {
    const oauth = authSettings.oauth;
    fastify.register(fastifyCookie);
    registerOAuthRoutes(fastify, oauth, authStore, { fetchImpl: deps.fetchImpl, rateLimit: limits.oauth });
    // Expired rows are ignored on read, but nothing deletes them, so a
    // long-lived database would grow without bound. unref so the sweep never
    // holds the process open.
    let purgeTimer: NodeJS.Timeout | undefined;
    const RESOLVE_USAGE_RETENTION_DAYS = 7;
    const purgeResolveUsageBefore = () =>
      new Date(Date.now() - RESOLVE_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    fastify.addHook("onReady", async () => {
      await authStore.init();
      await authStore.purgeExpired();
      await authStore.purgeResolveUsage(purgeResolveUsageBefore());
      purgeTimer = setInterval(() => {
        authStore.purgeExpired().catch((error) => fastify.log.warn({ err: error }, "OAuth purge failed"));
        authStore
          .purgeResolveUsage(purgeResolveUsageBefore())
          .catch((error) => fastify.log.warn({ err: error }, "resolve usage purge failed"));
      }, 60 * 60 * 1000);
      purgeTimer.unref();
    });
    fastify.addHook("onClose", async () => {
      if (purgeTimer) clearInterval(purgeTimer);
      await authStore.close();
    });
  }

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
    registerAccountRoutes(fastify, oauth, authStore, tenants, {
      lookup: deps.lookup,
      rateLimit: limits.connection,
    });

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

    fastify.post("/account/session", ipRateLimited(limits.oauth, "/account/session"), async (request, reply) => {
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

  fastify.get("/api/v1/search", subjectRateLimited(limits.subject, "/api/v1/search"), async (request, reply) => {
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

  fastify.get(
    "/api/v1/media/:mediaType/:tmdbId",
    subjectRateLimited(limits.subject, "/api/v1/media"),
    async (request, reply) => {
      const params = MediaParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: params.error.issues });
      }
      const tenant = tenantOf(request);
      if (!tenant?.client) {
        return reply.status(409).send({ error: notConnectedMessage(config.SEERRSENSE_PUBLIC_URL) });
      }
      return tenant.client.getMedia(params.data.mediaType, params.data.tmdbId);
    },
  );

  fastify.post(
    "/api/v1/request",
    subjectRateLimited(limits.subject, "/api/v1/request"),
    async (request, reply) => {
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
    },
  );

  // MCP v2 Protocol 2026-07-28 compliant Streamable HTTP endpoint
  // The factory runs per request and resolves the tenant from the same
  // AuthInfo the preHandler validated. It deliberately does not read the tenant
  // the preHandler attached to request.raw: ctx.requestInfo is a WHATWG Request
  // built from the Node request, not the Node request itself, so a property
  // hung off request.raw is simply not there and every caller would silently
  // look unconnected. Resolution is cached per subject, so this costs no extra
  // database read on the hot path.
  const resolveBudget = resolveBudgetSettings();

  const handler = createMcpHandler(async (ctx) => {
    const tenant = await tenants.resolve(ctx.authInfo);
    const budget = authStore ? { store: authStore, options: resolveBudget } : undefined;
    return createSeerrSenseMcpServer(ctx.authInfo?.scopes, tenant, budget);
  });
  const nodeHandler = toNodeHandler(handler);

  fastify.all("/mcp", subjectRateLimited(limits.subject, "/mcp"), async (request, reply) => {
    await nodeHandler(request.raw, reply.raw, request.body);
  });

  fastify.get(
    "/api/v1/resolve",
    subjectRateLimited(limits.subject, "/api/v1/resolve"),
    async (request, reply) => {
      const q = SearchQuerySchema.safeParse(request.query);
      if (!q.success) {
        return reply.status(400).send({ error: "Missing or invalid query parameter" });
      }

      const tenant = tenantOf(request);
      if (!tenant?.client) {
        return reply.status(409).send({ error: notConnectedMessage(config.SEERRSENSE_PUBLIC_URL) });
      }
      try {
        let intentExtractor: IntentExtractor | undefined = config.NEBIUS_API_KEY
          ? new NebiusIntentExtractor()
          : undefined;
        if (intentExtractor && authStore) {
          intentExtractor = new BudgetedIntentExtractor(intentExtractor, authStore, tenant.subject, resolveBudget);
        }
        const mediaResolver = new MediaResolver(tenant.client, intentExtractor);
        const result = await mediaResolver.resolveMedia(q.data.query);
        return reply.send(result);
      } catch (e: any) {
        if (e instanceof ResolveBudgetError) {
          return reply.status(429).send({ error: e.message });
        }
        return reply.status(500).send({ error: e.message });
      }
    },
  );
  });

  return fastify;
}
