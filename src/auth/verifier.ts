import type { AuthInfo } from "@modelcontextprotocol/server";
import { SCOPE_READ, SCOPE_REQUEST, type AuthSettings } from "./config.js";
import { safeEqual } from "./crypto.js";
import { verifyAccessToken } from "./tokens.js";

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Turns an Authorization header into AuthInfo, or throws.
 *
 * Two token shapes are accepted while the migration runs: an OAuth access token
 * issued by this server, and the pre-OAuth shared secret. The legacy path is
 * compared in constant time and disappears when SEERRSENSE_LEGACY_TOKEN_ENABLED
 * is set to false.
 */
export async function authenticate(
  settings: AuthSettings,
  authorizationHeader: string | undefined,
): Promise<AuthInfo> {
  if (!authorizationHeader) throw new UnauthorizedError("authentication required");
  const [scheme, token] = authorizationHeader.split(" ");
  if (!token || scheme?.toLowerCase() !== "bearer") {
    throw new UnauthorizedError("expected a Bearer token");
  }

  if (settings.oauth) {
    try {
      const claims = await verifyAccessToken({
        token,
        key: settings.oauth.signingKey,
        issuer: settings.oauth.issuer,
        audience: settings.oauth.resource,
      });
      return {
        token,
        clientId: claims.client_id,
        scopes: claims.scope.split(/\s+/).filter(Boolean),
        expiresAt: claims.exp,
        extra: { subject: claims.sub, email: claims.email },
      };
    } catch (error) {
      // Fall through to the legacy token: an OAuth deployment still accepts the
      // shared secret until it is switched off, and a JWT that fails here is
      // simply not a JWT this server issued.
      if (!settings.legacyToken) {
        throw new UnauthorizedError(
          error instanceof Error ? `invalid access token: ${error.message}` : "invalid access token",
        );
      }
    }
  }

  if (settings.legacyToken && safeEqual(token, settings.legacyToken)) {
    // The shared secret has no user behind it, so it carries every scope.
    return {
      token,
      clientId: "legacy-static-token",
      scopes: [SCOPE_READ, SCOPE_REQUEST],
      // Bearer verification refuses a token with no expiry; the shared secret
      // has none, so it is given a nominal one that outlives the request.
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      extra: { subject: "static-token", email: "" },
    };
  }

  throw new UnauthorizedError("invalid credentials");
}

/**
 * The RFC 9728 challenge. Without resource_metadata a client cannot discover
 * the authorization server, which is exactly why the pre-OAuth 401 left the
 * claude.ai connector unable to connect.
 */
export function wwwAuthenticate(settings: AuthSettings, error: "invalid_token" | "invalid_request"): string {
  const parts = [`Bearer realm="seerrsense"`, `error="${error}"`];
  if (settings.oauth) {
    parts.push(`resource_metadata="${settings.oauth.issuer}/.well-known/oauth-protected-resource/mcp"`);
  }
  return parts.join(", ");
}
