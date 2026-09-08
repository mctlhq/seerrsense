import { z } from "zod";
import { parsePreRegisteredClients, type ResolvedClient } from "./clients.js";

/** Scopes this resource understands. Nothing else is advertised or granted. */
export const SCOPE_READ = "seerr:read";
export const SCOPE_REQUEST = "seerr:request";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_REQUEST] as const;

const OAuthEnvSchema = z.object({
  SEERRSENSE_PUBLIC_URL: z.string().url().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  SEERRSENSE_OAUTH_JWT_SIGNING_KEY: z.string().optional(),
  SEERRSENSE_ALLOWED_EMAILS: z.string().optional(),
  SEERRSENSE_OAUTH_CLIENTS: z.string().optional(),
  SEERRSENSE_LEGACY_TOKEN_ENABLED: z.string().optional(),
  SEERRSENSE_ACCESS_TOKEN_TTL: z.coerce.number().int().positive().max(24 * 3600).default(3600),
  SEERRSENSE_REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(30 * 24 * 3600),
  DATABASE_URL: z.string().optional(),
});

export interface OAuthConfig {
  issuer: string;
  resource: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  signingKey: Uint8Array;
  allowedEmails: Set<string>;
  preRegisteredClients: ResolvedClient[];
  accessTokenTtl: number;
  refreshTokenTtl: number;
  databaseUrl?: string;
}

export interface AuthSettings {
  oauth?: OAuthConfig;
  /** The pre-OAuth shared token, accepted only while it is deliberately enabled. */
  legacyToken?: string;
}

/**
 * OAuth turns on only when every piece is present. A half-configured server
 * that advertised an authorization server it cannot run would send clients into
 * a flow that always fails; falling back to the legacy token is the honest
 * behaviour for a self-hoster who set none of this up.
 */
export function loadAuthSettings(
  env: Record<string, string | undefined>,
  legacyToken: string | undefined,
): AuthSettings {
  const parsed = OAuthEnvSchema.parse(env);
  const legacyEnabled = parsed.SEERRSENSE_LEGACY_TOKEN_ENABLED !== "false";
  const legacy = legacyEnabled ? legacyToken : undefined;

  const required = [
    parsed.SEERRSENSE_PUBLIC_URL,
    parsed.GOOGLE_OAUTH_CLIENT_ID,
    parsed.GOOGLE_OAUTH_CLIENT_SECRET,
    parsed.SEERRSENSE_OAUTH_JWT_SIGNING_KEY,
  ];
  if (required.some((value) => !value)) {
    if (required.some(Boolean)) {
      throw new Error(
        "OAuth is partially configured: SEERRSENSE_PUBLIC_URL, GOOGLE_OAUTH_CLIENT_ID, " +
          "GOOGLE_OAUTH_CLIENT_SECRET and SEERRSENSE_OAUTH_JWT_SIGNING_KEY must all be set, or none of them",
      );
    }
    return { legacyToken: legacy };
  }

  const signingKey = new TextEncoder().encode(parsed.SEERRSENSE_OAUTH_JWT_SIGNING_KEY!);
  // 32 bytes is the HS256 block size; a shorter key weakens the signature.
  if (signingKey.length < 32) {
    throw new Error("SEERRSENSE_OAUTH_JWT_SIGNING_KEY must be at least 32 bytes");
  }

  const issuer = parsed.SEERRSENSE_PUBLIC_URL!.replace(/\/$/, "");
  const allowedEmails = new Set(
    (parsed.SEERRSENSE_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );

  return {
    legacyToken: legacy,
    oauth: {
      issuer,
      resource: `${issuer}/mcp`,
      googleClientId: parsed.GOOGLE_OAUTH_CLIENT_ID!,
      googleClientSecret: parsed.GOOGLE_OAUTH_CLIENT_SECRET!,
      googleRedirectUri: `${issuer}/oauth/google/callback`,
      signingKey,
      allowedEmails,
      preRegisteredClients: parsePreRegisteredClients(parsed.SEERRSENSE_OAUTH_CLIENTS),
      accessTokenTtl: parsed.SEERRSENSE_ACCESS_TOKEN_TTL,
      refreshTokenTtl: parsed.SEERRSENSE_REFRESH_TOKEN_TTL,
      databaseUrl: parsed.DATABASE_URL,
    },
  };
}
