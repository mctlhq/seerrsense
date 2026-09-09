import { z } from "zod";
import { parsePreRegisteredClients, type ResolvedClient } from "./clients.js";
import { encryptionKeyFrom } from "./crypto.js";

/**
 * Scopes this resource understands. Nothing else is advertised or granted: a
 * scope advertised but not issued makes both ChatGPT and Claude show the user a
 * "not all permissions were granted" warning on a token that works fine.
 *
 * offline_access is listed because a refresh token is always issued. Claude
 * requests it only when it appears here, and a client that asks for it must not
 * be turned away with invalid_scope.
 */
export const SCOPE_READ = "seerr:read";
export const SCOPE_REQUEST = "seerr:request";
export const SCOPE_OFFLINE = "offline_access";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_REQUEST, SCOPE_OFFLINE] as const;

const OAuthEnvSchema = z.object({
  SEERRSENSE_PUBLIC_URL: z.string().url().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  SEERRSENSE_OAUTH_JWT_SIGNING_KEY: z.string().optional(),
  SEERRSENSE_ALLOWED_EMAILS: z.string().optional(),
  SEERRSENSE_OPEN_SIGNUP: z.string().optional(),
  SEERRSENSE_HOUSEHOLD_EMAILS: z.string().optional(),
  SEERRSENSE_ENCRYPTION_KEY: z.string().optional(),
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
  /** Seals the Seerr API keys people attach. Absent means nobody can attach one. */
  encryptionKey?: Buffer;
  allowedEmails: Set<string>;
  /**
   * When true, any Google account that passes the id_token and
   * email_verified checks is admitted, without consulting allowedEmails.
   * Strict equality to the string "true": a typo, "1" or "yes" all mean
   * closed, so a misspelled environment variable cannot silently open the
   * server.
   */
  openSignup: boolean;
  /**
   * Addresses allowed to fall back to the operator-configured household
   * Seerr when they have no user_connections row of their own. Fails
   * closed: unset or empty offers the household instance to no signed-in
   * subject.
   */
  householdEmails: Set<string>;
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
  const householdEmails = new Set(
    (parsed.SEERRSENSE_HOUSEHOLD_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  const openSignup = parsed.SEERRSENSE_OPEN_SIGNUP === "true";
  if (openSignup && !parsed.SEERRSENSE_ENCRYPTION_KEY) {
    // Not a hard failure: a self-hoster may run open signup on a server they
    // administer directly, without ever attaching a per-user Seerr. But on the
    // hosted instance this means people are admitted to a server they cannot
    // use, which is worth a loud warning rather than a silent no-op.
    console.warn(
      "SEERRSENSE_OPEN_SIGNUP is true but SEERRSENSE_ENCRYPTION_KEY is not set: " +
        "people will be able to sign in but nobody will be able to attach a Seerr",
    );
  }

  return {
    legacyToken: legacy,
    oauth: {
      issuer,
      resource: `${issuer}/mcp`,
      googleClientId: parsed.GOOGLE_OAUTH_CLIENT_ID!,
      googleClientSecret: parsed.GOOGLE_OAUTH_CLIENT_SECRET!,
      googleRedirectUri: `${issuer}/oauth/google/callback`,
      signingKey,
      encryptionKey: parsed.SEERRSENSE_ENCRYPTION_KEY
        ? encryptionKeyFrom(parsed.SEERRSENSE_ENCRYPTION_KEY)
        : undefined,
      allowedEmails,
      openSignup,
      householdEmails,
      // The account page is a client of this server. Its client_id is an https
      // URL with a path, which would otherwise be treated as a Client ID
      // Metadata Document and fetched — from ourselves, where that path serves
      // HTML, not JSON. Registering it here is both correct and cheaper.
      preRegisteredClients: [
        {
          clientId: `${issuer}/account`,
          clientName: "SeerrSense account page",
          redirectUris: [`${issuer}/account/callback`],
          source: "pre-registered" as const,
        },
        ...parsePreRegisteredClients(parsed.SEERRSENSE_OAUTH_CLIENTS),
      ],
      accessTokenTtl: parsed.SEERRSENSE_ACCESS_TOKEN_TTL,
      refreshTokenTtl: parsed.SEERRSENSE_REFRESH_TOKEN_TTL,
      databaseUrl: parsed.DATABASE_URL,
    },
  };
}
