import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "seerrsense_session";
export const SESSION_TTL_SECONDS = 8 * 3600;

/** What a revocation check is given: enough to refuse one cookie by its
 * `jti`, or every cookie a subject was issued before a moment. */
export interface SessionRevocationCheck {
  id?: string;
  subject: string;
  /** The token's `iat`, in epoch milliseconds. */
  issuedAt?: number;
}

export interface Session {
  subject: string;
  email: string;
  /** The token's `jti`. Undefined for a cookie issued before sessions carried
   * one; it still verifies, just cannot be individually revoked. */
  id?: string;
  /** The token's `exp`, in epoch milliseconds — what a revocation record
   * should be retained until. */
  expiresAt?: number;
}

/**
 * The browser session for the account page.
 *
 * Deliberately not the same credential as an MCP access token. A cookie is sent
 * by the browser on every request to this origin, which is what makes the page
 * work and also what makes it unsuitable for /mcp; this one carries its own
 * audience and is refused anywhere else. It only ever authorises reading and
 * writing the signed-in person's own Seerr connection.
 */
export async function issueSession(
  session: Session,
  key: Uint8Array,
  issuer: string,
): Promise<{ value: string; maxAge: number }> {
  const value = await new SignJWT({ email: session.email })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(`${issuer}/account`)
    .setSubject(session.subject)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
    .sign(key);
  return { value, maxAge: SESSION_TTL_SECONDS };
}

export async function readSession(
  cookie: string | undefined,
  key: Uint8Array,
  issuer: string,
  /** Injectable so a revoked `jti` (sign-out), or a subject whose every
   * session was ended (account deletion), refuses a replayed cookie. Absent
   * means every cookie is trusted statelessly, as before. */
  isRevoked?: (check: SessionRevocationCheck) => Promise<boolean>,
): Promise<Session | undefined> {
  if (!cookie) return undefined;
  try {
    const { payload } = await jwtVerify(cookie, key, {
      issuer,
      audience: `${issuer}/account`,
      algorithms: ["HS256"],
    });
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return undefined;
    // A cookie issued before sessions carried a jti cannot be revoked on its
    // own, but it still names its subject and its issue time, so ending every
    // session of that subject reaches it too.
    if (
      isRevoked &&
      (await isRevoked({
        id: typeof payload.jti === "string" ? payload.jti : undefined,
        subject: payload.sub,
        issuedAt: typeof payload.iat === "number" ? payload.iat * 1000 : undefined,
      }))
    ) {
      return undefined;
    }
    return {
      subject: payload.sub,
      email: payload.email,
      id: typeof payload.jti === "string" ? payload.jti : undefined,
      expiresAt: typeof payload.exp === "number" ? payload.exp * 1000 : undefined,
    };
  } catch {
    return undefined;
  }
}
