import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ClientResolutionError, ClientResolver, isAllowedRedirectUri } from "./clients.js";
import { SCOPE_OFFLINE, SCOPE_READ, SUPPORTED_SCOPES, type OAuthConfig } from "./config.js";
import { hashToken, isValidPkceString, randomToken, verifyPkceS256 } from "./crypto.js";
import { GoogleOidc } from "./google.js";
import type { AuthStore } from "./store.js";
import { signAccessToken } from "./tokens.js";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
/** How long the consent screen may sit open before the approved login expires. */
const CONSENT_TTL_MS = 10 * 60 * 1000;

/**
 * Bounds on every client-controlled string on the unauthenticated authorize
 * endpoint. Without them a caller chooses how much memory a pending login
 * costs. state is generous because OpenAI's Apps client packs a relay blob
 * into it.
 */
const AuthorizeQuerySchema = z.object({
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().min(1).max(2048),
  response_type: z.literal("code"),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(4096).optional(),
  scope: z.string().max(1024).optional(),
  resource: z.string().max(2048).optional(),
  login_hint: z.string().max(320).optional(),
});

const TokenBodySchema = z.object({
  grant_type: z.enum(["authorization_code", "refresh_token"]),
  code: z.string().max(2048).optional(),
  redirect_uri: z.string().max(2048).optional(),
  client_id: z.string().max(2048).optional(),
  code_verifier: z.string().max(128).optional(),
  refresh_token: z.string().max(2048).optional(),
  resource: z.string().max(2048).optional(),
});

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.status(status).send({ error, error_description: description });
}

/** Errors that reach the client through its redirect_uri, per RFC 6749 §4.1.2.1. */
function redirectError(
  reply: FastifyReply,
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
  issuer: string,
) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== undefined) url.searchParams.set("state", state);
  // RFC 9207: name the authorization server in every response so a client
  // talking to several cannot be fed a code minted by a different one.
  url.searchParams.set("iss", issuer);
  return reply.redirect(url.toString(), 302);
}

/** Everything interpolated below comes from a fetched client document, so it is untrusted. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SCOPE_LABELS: Record<string, string> = {
  "seerr:read": "Search your media library and read what is available",
  "seerr:request": "Request new films and series on your behalf",
  offline_access: "Stay connected without asking you to sign in again",
};

/**
 * The one screen a person sees on this server.
 *
 * It exists for a specific reason, not for ceremony: the MCP authorization spec
 * requires the redirect host to be shown when a client redirects to loopback,
 * because any local process can bind a port and claim to be Claude Code. Showing
 * it for every client keeps one code path and one habit.
 *
 * It doubles as the hand-off confirmation. A bare 302 back to the client leaves
 * the person staring at a browser tab with no idea whether it worked, and they
 * retry — each retry a fresh client registration upstream. A button click is
 * also the user gesture a browser wants before handing focus to a desktop app.
 */
function consentPage(params: {
  clientName: string;
  redirectHost: string;
  email: string;
  scopes: string[];
  code: string;
  issuer: string;
}): string {
  const scopeItems = params.scopes
    .map((scope) => `<li>${escapeHtml(SCOPE_LABELS[scope] ?? scope)}</li>`)
    .join("\n        ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to SeerrSense</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/components.css">
<style>
  main { max-width: 460px; margin: 0 auto; padding: 64px 24px; }
  .who { margin: 0 0 28px; color: var(--surface-fg-muted); }
  .grants { margin: 0 0 28px; padding-left: 20px; color: var(--surface-fg-muted); }
  .grants li { margin-bottom: 8px; }
  .target { display: block; margin-top: 6px; font-family: var(--font-mono); font-size: 13px;
            color: var(--surface-fg-subtle); overflow-wrap: anywhere; }
  .actions { display: flex; gap: 12px; }
  .actions form { flex: 1; }
  .actions button { width: 100%; justify-content: center; }
</style>
</head>
<body>
<main>
  <p class="eyebrow">Authorize</p>
  <h2>${escapeHtml(params.clientName)} wants to use SeerrSense</h2>
  <p class="who">Signed in as ${escapeHtml(params.email)}.
    <span class="target">You will be returned to ${escapeHtml(params.redirectHost)}</span>
  </p>
  <ul class="grants">
        ${scopeItems}
  </ul>
  <div class="actions">
    <form method="post" action="/oauth/consent">
      <input type="hidden" name="code" value="${escapeHtml(params.code)}">
      <input type="hidden" name="decision" value="deny">
      <button class="btn btn-secondary" type="submit">Cancel</button>
    </form>
    <form method="post" action="/oauth/consent">
      <input type="hidden" name="code" value="${escapeHtml(params.code)}">
      <input type="hidden" name="decision" value="allow">
      <button class="btn btn-primary" type="submit">Allow</button>
    </form>
  </div>
</main>
</body>
</html>`;
}

/**
 * Redeems an authorization code. Shared by the token endpoint and by the
 * account page's own sign-in, which runs in this process and must not make an
 * HTTP request to its own token endpoint to do what this function does.
 */
export interface RedeemedCode {
  clientId: string;
  scope: string;
  resource: string;
  subject: string;
  email: string;
}

export async function redeemAuthorizationCode(
  store: AuthStore,
  params: { code: string; codeVerifier: string; redirectUri: string; clientId?: string },
): Promise<{ ok: true; grant: RedeemedCode } | { ok: false; description: string }> {
  if (!isValidPkceString(params.codeVerifier)) {
    return { ok: false, description: "code_verifier is malformed" };
  }
  const record = await store.takeAuthCode(params.code);
  if (!record) return { ok: false, description: "this code is unknown or expired" };
  if (params.clientId && params.clientId !== record.clientId) {
    return { ok: false, description: "this code was issued to another client" };
  }
  if (params.redirectUri !== record.redirectUri) {
    return { ok: false, description: "redirect_uri does not match the code" };
  }
  if (!verifyPkceS256(params.codeVerifier, record.codeChallenge)) {
    return { ok: false, description: "code_verifier does not match the challenge" };
  }
  return {
    ok: true,
    grant: {
      clientId: record.clientId,
      scope: record.scope,
      resource: record.resource,
      subject: record.subject,
      email: record.email,
    },
  };
}

export function registerOAuthRoutes(
  fastify: FastifyInstance,
  config: OAuthConfig,
  store: AuthStore,
  deps: { fetchImpl?: typeof fetch } = {},
) {
  // RFC 6749 §4.1.3 defines the token request as form-encoded, and that is what
  // real clients send. Fastify parses only JSON out of the box, so without this
  // every token request would be refused with a content-type error.
  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 64 * 1024 },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  const google = new GoogleOidc(
    config.googleClientId,
    config.googleClientSecret,
    config.googleRedirectUri,
    deps.fetchImpl ?? fetch,
  );
  const clients = new ClientResolver(config.preRegisteredClients, deps.fetchImpl ?? fetch);

  // RFC 8414. registration_endpoint is deliberately absent: Dynamic Client
  // Registration is deprecated in MCP 2026-07-28 in favour of Client ID
  // Metadata Documents, which is what the flag below advertises.
  const authorizationServerMetadata = {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oauth/authorize`,
    token_endpoint: `${config.issuer}/oauth/token`,
    revocation_endpoint: `${config.issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SUPPORTED_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };

  // RFC 9728. Served at both the bare path and the /mcp-suffixed one, because
  // a client derives the URL from the resource it was refused access to.
  const protectedResourceMetadata = {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "SeerrSense",
  };

  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
  ]) {
    fastify.get(path, async (_request, reply) =>
      reply.header("cache-control", "public, max-age=3600").send(authorizationServerMetadata),
    );
  }

  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    fastify.get(path, async (_request, reply) =>
      reply.header("cache-control", "public, max-age=3600").send(protectedResourceMetadata),
    );
  }

  fastify.get("/oauth/authorize", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = AuthorizeQuerySchema.safeParse(request.query);
    if (!query.success) {
      // Nothing is redirected here: the redirect_uri is not trusted until the
      // client is resolved, so an invalid request answers on this connection.
      return oauthError(reply, 400, "invalid_request", query.error.issues[0]?.message ?? "invalid request");
    }
    const params = query.data;

    let client;
    try {
      client = await clients.resolve(params.client_id);
    } catch (error) {
      const description =
        error instanceof ClientResolutionError ? error.message : "client_id could not be resolved";
      return oauthError(reply, 400, "invalid_client", description);
    }
    if (!isAllowedRedirectUri(client, params.redirect_uri)) {
      return oauthError(
        reply,
        400,
        "invalid_request",
        "redirect_uri is not listed for this client",
      );
    }

    if (params.resource && params.resource !== config.resource) {
      return redirectError(reply, params.redirect_uri, "invalid_target",
        `this server only issues tokens for ${config.resource}`, params.state, config.issuer);
    }

    const requested = (params.scope ?? SCOPE_READ).split(/\s+/).filter(Boolean);
    const unknown = requested.filter((scope) => !SUPPORTED_SCOPES.includes(scope as never));
    if (unknown.length > 0) {
      return redirectError(reply, params.redirect_uri, "invalid_scope",
        `unsupported scope: ${unknown.join(" ")}`, params.state, config.issuer);
    }

    const state = randomToken();
    const googleVerifier = randomToken() + randomToken().slice(0, 11); // 43-128 chars
    const googleNonce = randomToken();
    await store.putPendingAuth({
      state,
      clientId: client.clientId,
      redirectUri: params.redirect_uri,
      clientState: params.state,
      codeChallenge: params.code_challenge,
      scope: requested.join(" "),
      resource: config.resource,
      googleVerifier,
      googleNonce,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    const url = await google.authorizationUrl({
      state,
      codeVerifier: googleVerifier,
      nonce: googleNonce,
      loginHint: params.login_hint,
    });
    return reply.redirect(url, 302);
  });

  fastify.get("/oauth/google/callback", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    if (!query.state) return oauthError(reply, 400, "invalid_request", "state is missing");

    const pending = await store.takePendingAuth(query.state);
    if (!pending) {
      return oauthError(reply, 400, "invalid_request", "this login has expired or was already used");
    }
    if (query.error) {
      return redirectError(reply, pending.redirectUri, "access_denied",
        `Google returned ${query.error}`, pending.clientState, config.issuer);
    }
    if (!query.code) {
      return redirectError(reply, pending.redirectUri, "invalid_request",
        "Google returned no code", pending.clientState, config.issuer);
    }

    let identity;
    try {
      identity = await google.exchangeCode(query.code, pending.googleVerifier, pending.googleNonce);
    } catch (error) {
      request.log.warn({ err: error }, "Google authentication failed");
      return redirectError(reply, pending.redirectUri, "access_denied",
        "Google authentication failed", pending.clientState, config.issuer);
    }

    // Fail closed: an empty allowlist admits nobody, so a missing environment
    // variable cannot silently open the server to every Google account.
    if (!config.allowedEmails.has(identity.email)) {
      request.log.warn({ email: identity.email }, "rejected a Google account outside the allowlist");
      return redirectError(reply, pending.redirectUri, "access_denied",
        "this account is not allowed to use this server", pending.clientState, config.issuer);
    }

    // Google has said who this is; nothing is granted until the person answers
    // the consent screen. The approved login is parked under a fresh single-use
    // handle so the browser cannot carry anything but that handle across.
    const consentHandle = randomToken();
    await store.putPendingAuth({
      ...pending,
      state: consentHandle,
      subject: `google:${identity.subject}`,
      email: identity.email,
      expiresAt: Date.now() + CONSENT_TTL_MS,
    });

    let clientName = pending.clientId;
    try {
      clientName = (await clients.resolve(pending.clientId)).clientName;
    } catch {
      // Already resolved once at /authorize; a failure here is a cache miss on
      // an unreachable document, not a reason to refuse a verified login.
    }

    return reply
      .header("content-type", "text/html; charset=utf-8")
      // form-action must allow https: — this page POSTs to us and the answer is
      // a redirect to the client's own host. 'self' alone silently blocks that
      // hop and the button appears to do nothing.
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; base-uri 'none'",
      )
      .header("cache-control", "no-store")
      .send(
        consentPage({
          clientName,
          redirectHost: new URL(pending.redirectUri).host,
          email: identity.email,
          scopes: pending.scope.split(/\s+/).filter(Boolean),
          code: consentHandle,
          issuer: config.issuer,
        }),
      );
  });

  fastify.post("/oauth/consent", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { code?: string; decision?: string };
    if (typeof body.code !== "string" || body.code.length === 0) {
      return oauthError(reply, 400, "invalid_request", "this consent form is incomplete");
    }
    const approved = await store.takePendingAuth(body.code);
    if (!approved || !approved.subject || !approved.email) {
      return oauthError(reply, 400, "invalid_request", "this consent has expired or was already answered");
    }

    if (body.decision !== "allow") {
      return redirectError(reply, approved.redirectUri, "access_denied",
        "the user declined", approved.clientState, config.issuer);
    }

    const code = randomToken();
    await store.putAuthCode({
      code,
      clientId: approved.clientId,
      redirectUri: approved.redirectUri,
      clientState: approved.clientState,
      codeChallenge: approved.codeChallenge,
      scope: approved.scope,
      resource: approved.resource,
      subject: approved.subject,
      email: approved.email,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    const url = new URL(approved.redirectUri);
    url.searchParams.set("code", code);
    if (approved.clientState !== undefined) url.searchParams.set("state", approved.clientState);
    url.searchParams.set("iss", config.issuer);
    return reply.redirect(url.toString(), 302);
  });

  fastify.post("/oauth/token", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = TokenBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return oauthError(reply, 400, "invalid_request", body.error.issues[0]?.message ?? "invalid request");
    }
    const params = body.data;

    // ChatGPT sends `resource` on the token request as well as the
    // authorization request; a value naming somebody else's server must not be
    // silently accepted and then contradicted by the audience we mint.
    if (params.resource && params.resource !== config.resource) {
      return oauthError(reply, 400, "invalid_target",
        `this server only issues tokens for ${config.resource}`);
    }

    if (params.grant_type === "authorization_code") {
      if (!params.code || !params.code_verifier || !params.redirect_uri) {
        return oauthError(reply, 400, "invalid_request",
          "code, code_verifier and redirect_uri are required");
      }
      const redeemed = await redeemAuthorizationCode(store, {
        code: params.code,
        codeVerifier: params.code_verifier,
        redirectUri: params.redirect_uri,
        clientId: params.client_id,
      });
      if (!redeemed.ok) return oauthError(reply, 400, "invalid_grant", redeemed.description);
      return issueTokens(reply, { ...redeemed.grant, familyId: randomToken() });
    }

    if (!params.refresh_token) {
      return oauthError(reply, 400, "invalid_request", "refresh_token is required");
    }
    const tokenHash = hashToken(params.refresh_token);
    const record = await store.getRefreshToken(tokenHash);
    if (!record || record.expiresAt < Date.now()) {
      return oauthError(reply, 400, "invalid_grant", "this refresh token is unknown or expired");
    }
    if (record.consumedAt !== undefined) {
      // A rotated token presented a second time means the holder is not the
      // only one with it. Nothing in this family can be trusted any more.
      await store.revokeFamily(record.familyId);
      request.log.warn({ familyId: record.familyId }, "refresh token replayed; revoked the family");
      return oauthError(reply, 400, "invalid_grant", "this refresh token was already used");
    }
    if (params.client_id && params.client_id !== record.clientId) {
      return oauthError(reply, 400, "invalid_grant", "this token was issued to another client");
    }
    await store.markRefreshConsumed(tokenHash);
    return issueTokens(reply, {
      clientId: record.clientId,
      scope: record.scope,
      resource: record.resource,
      subject: record.subject,
      email: record.email,
      familyId: record.familyId,
    });
  });

  fastify.post("/oauth/revoke", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { token?: string };
    // RFC 7009: an unknown token is not an error, so revocation cannot be used
    // to probe which tokens exist.
    if (typeof body.token === "string" && body.token.length > 0) {
      const hash = hashToken(body.token);
      const record = await store.getRefreshToken(hash);
      if (record) await store.revokeFamily(record.familyId);
      else await store.revokeToken(hash);
    }
    return reply.status(200).send({});
  });

  async function issueTokens(
    reply: FastifyReply,
    grant: {
      clientId: string;
      scope: string;
      resource: string;
      subject: string;
      email: string;
      familyId: string;
    },
  ) {
    const access = await signAccessToken({
      key: config.signingKey,
      issuer: config.issuer,
      audience: grant.resource,
      subject: grant.subject,
      email: grant.email,
      scope: grant.scope,
      clientId: grant.clientId,
      ttlSeconds: config.accessTokenTtl,
    });
    const refreshToken = randomToken();
    await store.putRefreshToken({
      tokenHash: hashToken(refreshToken),
      familyId: grant.familyId,
      clientId: grant.clientId,
      scope: grant.scope,
      resource: grant.resource,
      subject: grant.subject,
      email: grant.email,
      expiresAt: Date.now() + config.refreshTokenTtl * 1000,
    });
    return reply
      .header("cache-control", "no-store")
      .send({
        access_token: access.token,
        token_type: "Bearer",
        expires_in: config.accessTokenTtl,
        refresh_token: refreshToken,
        scope: grant.scope,
      });
  }
}
