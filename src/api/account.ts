import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { OAuthConfig } from "../auth/config.js";
import { open, seal } from "../auth/crypto.js";
import { readSession, SESSION_COOKIE, SESSION_TTL_SECONDS, type Session } from "../auth/session.js";
import type { AuthStore } from "../auth/store.js";
import { SeerrAccessChallengeError, SeerrClient, SeerrUnreachableError } from "../providers/seerr/client.js";
import { assertPublicSeerrUrl, BlockedAddressError } from "../providers/seerr/guard.js";
import type { TenantResolver } from "../providers/seerr/tenants.js";

const ConnectionSchema = z.object({
  seerrUrl: z.string().url().max(2048),
  // Blank means "keep the key already stored", so someone can change the
  // address without re-typing a secret they no longer have to hand.
  apiKey: z.string().max(512).optional(),
  cfAccessClientId: z.string().max(512).optional(),
  cfAccessClientSecret: z.string().max(512).optional(),
});

/**
 * The account API behind the settings page.
 *
 * It authenticates with the browser session cookie only, never with an MCP
 * access token: an assistant holding a token must not be able to read or
 * rewrite which Seerr it talks to, and a person must never be asked to paste an
 * API key into a chat.
 */
export function registerAccountRoutes(
  fastify: FastifyInstance,
  config: OAuthConfig,
  store: AuthStore,
  tenants: TenantResolver,
  deps: {
    lookup?: (host: string) => Promise<string[]>;
    rateLimit?: { max: number; timeWindow: number };
  } = {},
) {
  const putRateLimitConfig = deps.rateLimit
    ? {
        config: {
          rateLimit: {
            max: deps.rateLimit.max,
            timeWindow: deps.rateLimit.timeWindow,
            keyGenerator: (req: FastifyRequest) => req.ip,
            onExceeded: (req: FastifyRequest) => {
              req.log.warn(
                { route: "/api/v1/account/connection", key: "ip" },
                "rate limit exceeded",
              );
            },
          },
        },
      }
    : {};

  async function sessionOf(request: FastifyRequest): Promise<Session | undefined> {
    const cookies = (request as unknown as { cookies?: Record<string, string | undefined> }).cookies;
    const cookie = cookies?.[SESSION_COOKIE];
    return readSession(cookie, config.signingKey, config.issuer, async (check) => {
      if (check.id && (await store.isSessionRevoked(check.id))) return true;
      // A cookie with no iat cannot be placed before a deletion; it is a
      // pre-jti legacy cookie and is refused outright once its subject has
      // ever been deleted, which is the safer reading.
      return store.isSubjectSessionRevoked(check.subject, check.issuedAt ?? Number.MAX_SAFE_INTEGER);
    });
  }

  function requireEncryption(reply: FastifyReply): Buffer | undefined {
    if (!config.encryptionKey) {
      reply.status(503).send({
        error: "this server cannot store connections: SEERRSENSE_ENCRYPTION_KEY is not set",
      });
      return undefined;
    }
    return config.encryptionKey;
  }

  fastify.get("/api/v1/account/connection", async (request, reply) => {
    const session = await sessionOf(request);
    if (!session) return reply.status(401).send({ error: "not signed in" });

    const connection = await store.getUserConnection(session.subject);
    return reply.header("cache-control", "no-store").send({
      email: session.email,
      connected: connection !== undefined,
      // What this caller reaches with no connection of their own — the
      // resolver's own answer, not a second reading of
      // SEERRSENSE_HOUSEHOLD_EMAILS.
      fallback: tenants.householdFallback(session.email, session.subject),
      // The key itself is never returned, not even masked.
      seerrUrl: connection?.seerrUrl,
      cfAccessConfigured: connection?.cfAccessClientIdSealed !== undefined,
      updatedAt: connection?.updatedAt,
    });
  });

  fastify.put("/api/v1/account/connection", putRateLimitConfig, async (request, reply) => {
    const session = await sessionOf(request);
    if (!session) return reply.status(401).send({ error: "not signed in" });
    const key = requireEncryption(reply);
    if (!key) return reply;

    const body = ConnectionSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid request" });
    }

    const existing = await store.getUserConnection(session.subject);
    const apiKey = body.data.apiKey?.trim()
      ? body.data.apiKey.trim()
      : existing
        ? open(existing.seerrApiKeySealed, key)
        : undefined;
    if (!apiKey) {
      return reply.status(400).send({ error: "an API key is required the first time" });
    }

    // Validate the address before any network call is made at all: this is
    // what makes it true that a blocked address is never dialled, not even
    // once, to prove the credentials.
    try {
      await assertPublicSeerrUrl(body.data.seerrUrl, { lookup: deps.lookup });
    } catch (error) {
      if (error instanceof BlockedAddressError) {
        // The address itself is the person's own infrastructure and stays out
        // of the log; that it was blocked, and why, is all an operator needs.
        request.log.warn({ reason: error.message }, "rejected a Seerr connection address");
        return reply.status(400).send({ error: "That address cannot be used. Check it and try again." });
      }
      throw error;
    }

    const candidate = new SeerrClient({
      baseUrl: body.data.seerrUrl,
      apiKey,
      cfAccessClientId: body.data.cfAccessClientId,
      cfAccessClientSecret: body.data.cfAccessClientSecret,
      untrusted: true,
      lookup: deps.lookup,
    });

    // Prove the credentials before storing them: a typo in the key would
    // otherwise only surface later, inside an assistant, as an opaque failure.
    // The candidate exists only to prove the credentials; its pinned
    // dispatcher must not outlive that, or every PUT leaks an agent.
    let seerrUser: string | undefined;
    try {
      seerrUser = await candidate.describeSelf();
    } catch (error) {
      void candidate.close();
      request.log.info({ err: error }, "rejected a Seerr connection that did not answer");
      if (error instanceof SeerrAccessChallengeError) {
        return reply.status(400).send({
          error:
            "That address is behind Cloudflare Access — fill in the Zero Trust fields " +
            "(CF-Access-Client-Id and CF-Access-Client-Secret).",
        });
      }
      if (error instanceof SeerrUnreachableError || error instanceof BlockedAddressError) {
        return reply.status(400).send({
          error: "Could not reach that Seerr. Check the address and key and try again.",
        });
      }
      return reply.status(400).send({
        error: "That Seerr did not accept the address and key. Check both and try again.",
      });
    }
    void candidate.close();

    await store.putUserConnection({
      subject: session.subject,
      email: session.email,
      seerrUrl: body.data.seerrUrl.replace(/\/$/, ""),
      seerrApiKeySealed: seal(apiKey, key),
      cfAccessClientIdSealed: body.data.cfAccessClientId
        ? seal(body.data.cfAccessClientId, key)
        : undefined,
      cfAccessClientSecretSealed: body.data.cfAccessClientSecret
        ? seal(body.data.cfAccessClientSecret, key)
        : undefined,
      updatedAt: Date.now(),
    });
    // Without this the person keeps reaching the old instance for a minute.
    tenants.forget(session.subject);

    return reply.header("cache-control", "no-store").send({
      connected: true,
      seerrUrl: body.data.seerrUrl.replace(/\/$/, ""),
      seerrUser,
    });
  });

  fastify.delete("/api/v1/account/connection", async (request, reply) => {
    const session = await sessionOf(request);
    if (!session) return reply.status(401).send({ error: "not signed in" });
    await store.deleteUserConnection(session.subject);
    tenants.forget(session.subject);
    return reply.header("cache-control", "no-store").send({
      connected: false,
      fallback: tenants.householdFallback(session.email, session.subject),
    });
  });

  // "Delete my account": everything the store holds about this person, then
  // every browser session they hold — the one that asked and any other
  // device's, since a surviving cookie could attach a fresh Seerr to an
  // account that was just deleted. Access tokens already issued live out
  // their hour, since they are stateless; nothing they reach will exist.
  //
  // Metered like the connection PUT, per IP. The subject is Google's stable
  // `sub`, so deleting and signing in again yields the same subject with a
  // fresh resolve counter; unmetered, that would be a free daily budget
  // reset. A handful per five minutes keeps it a deletion, not a loop.
  fastify.delete("/api/v1/account", putRateLimitConfig, async (request, reply) => {
    const session = await sessionOf(request);
    if (!session) return reply.status(401).send({ error: "not signed in" });
    await store.deleteSubject(session.subject);
    tenants.forget(session.subject);
    const now = Date.now();
    // A JWT's iat has one-second resolution, so "everything issued before
    // now" is everything issued before this second began; a cookie minted in
    // the same second as the deletion cannot be told apart from one minted
    // just after it. The session that asked is revoked by its jti as well, so
    // that one is covered regardless of timing.
    const before = Math.floor(now / 1000) * 1000 - 1;
    await store.revokeSubjectSessions(session.subject, before, now + SESSION_TTL_SECONDS * 1000);
    if (session.id && session.expiresAt) {
      await store.revokeSession(session.id, session.expiresAt);
    }
    return reply
      .header("cache-control", "no-store")
      .clearCookie(SESSION_COOKIE, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: config.issuer.startsWith("https://"),
      })
      .send({ deleted: true });
  });

  // Ends the browser session only. MCP grants (refresh and access tokens) are
  // untouched here — those are revoked only via POST /oauth/revoke — so
  // signing out of the account page never signs an assistant out.
  fastify.delete("/api/v1/account/session", async (request, reply) => {
    const session = await sessionOf(request);
    if (session?.id && session.expiresAt) {
      await store.revokeSession(session.id, session.expiresAt);
    }
    return reply
      .header("cache-control", "no-store")
      .clearCookie(SESSION_COOKIE, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: config.issuer.startsWith("https://"),
      })
      .send({ signedOut: true });
  });
}
