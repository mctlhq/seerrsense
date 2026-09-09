import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { OAuthConfig } from "../auth/config.js";
import { open, seal } from "../auth/crypto.js";
import { readSession, SESSION_COOKIE, type Session } from "../auth/session.js";
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
    return readSession(cookie, config.signingKey, config.issuer);
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
        request.log.warn(
          { host: new URL(body.data.seerrUrl).hostname },
          "rejected a Seerr connection address",
        );
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
    let seerrUser: string | undefined;
    try {
      seerrUser = await candidate.describeSelf();
    } catch (error) {
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
    return reply.header("cache-control", "no-store").send({ connected: false });
  });
}
