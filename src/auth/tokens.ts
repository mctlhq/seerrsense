import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { randomToken } from "./crypto.js";

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  email: string;
  scope: string;
  client_id: string;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: number;
  jti: string;
}

/**
 * Access tokens are self-contained HS256 JWTs: the resource server verifies
 * them without a database round trip, which is what keeps /mcp stateless.
 * Revocation therefore applies to refresh tokens, and access tokens are kept
 * short-lived so a revoked session dies within one TTL.
 */
export async function signAccessToken(params: {
  key: Uint8Array;
  issuer: string;
  audience: string;
  subject: string;
  email: string;
  scope: string;
  clientId: string;
  ttlSeconds: number;
}): Promise<IssuedAccessToken> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + params.ttlSeconds;
  const jti = randomToken();
  const token = await new SignJWT({
    email: params.email,
    scope: params.scope,
    client_id: params.clientId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(params.issuer)
    .setAudience(params.audience)
    .setSubject(params.subject)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .setJti(jti)
    .sign(params.key);
  return { token, expiresAt, jti };
}

export async function verifyAccessToken(params: {
  token: string;
  key: Uint8Array;
  issuer: string;
  audience: string;
}): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(params.token, params.key, {
    issuer: params.issuer,
    audience: params.audience,
    algorithms: ["HS256"],
  });
  const claims = payload as AccessTokenClaims;
  if (!claims.sub || typeof claims.scope !== "string") {
    throw new Error("access token is missing sub or scope");
  }
  return claims;
}
