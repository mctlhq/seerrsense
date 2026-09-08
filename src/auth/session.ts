import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "seerrsense_session";
const SESSION_TTL_SECONDS = 8 * 3600;

export interface Session {
  subject: string;
  email: string;
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
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
    .sign(key);
  return { value, maxAge: SESSION_TTL_SECONDS };
}

export async function readSession(
  cookie: string | undefined,
  key: Uint8Array,
  issuer: string,
): Promise<Session | undefined> {
  if (!cookie) return undefined;
  try {
    const { payload } = await jwtVerify(cookie, key, {
      issuer,
      audience: `${issuer}/account`,
      algorithms: ["HS256"],
    });
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return undefined;
    return { subject: payload.sub, email: payload.email };
  } catch {
    return undefined;
  }
}
