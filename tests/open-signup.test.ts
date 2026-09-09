import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { createHash, randomBytes } from "node:crypto";

// The household Seerr is irrelevant to signup itself; stubbed the same way
// every other server test stubs it.
import { vi } from "vitest";
const householdSeerr = vi.hoisted(() => ({
  status: vi.fn().mockResolvedValue({ status: 200 }),
  search: vi.fn().mockResolvedValue([]),
  findUserIdByEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/providers/seerr/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/seerr/client.js")>()),
  seerrClient: householdSeerr,
  createDefaultSeerrClient: () => householdSeerr,
}));

const ISSUER = "https://seerrsense.test";
const ALLOWED_EMAIL = "owner@example.com";
const STRANGER_EMAIL = "stranger@example.com";

let signPrivateKey: CryptoKey;
let googleJwks: { keys: unknown[] };
let lastGoogleNonce: string | undefined;
/** The address Google reports back for this test's flow. */
let currentEmail = ALLOWED_EMAIL;

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
function makeVerifier(): string {
  return base64url(randomBytes(48)).slice(0, 64);
}

async function stubFetch(input: any): Promise<Response> {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  if (url === `${ISSUER}/account`) {
    return json({
      client_id: `${ISSUER}/account`,
      client_name: "SeerrSense account page",
      redirect_uris: [`${ISSUER}/account/callback`],
    });
  }
  if (url.startsWith("https://accounts.google.com/.well-known/openid-configuration")) {
    return json({
      issuer: "https://accounts.google.com",
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
    });
  }
  if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return json(googleJwks);
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    const idToken = await new SignJWT({ email: currentEmail, email_verified: true, nonce: lastGoogleNonce })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience("google-client-id")
      .setSubject("google-sub-open-signup")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signPrivateKey);
    return json({ id_token: idToken });
  }
  throw new Error(`unexpected fetch in test: ${url}`);
}

let buildServer: typeof import("../src/api/server.js").buildServer;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signPrivateKey = pair.privateKey;
  googleJwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" }] };

  process.env.SEERRSENSE_PUBLIC_URL = ISSUER;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-client-secret";
  process.env.SEERRSENSE_OAUTH_JWT_SIGNING_KEY = "x".repeat(48);
  process.env.SEERRSENSE_ALLOWED_EMAILS = ALLOWED_EMAIL;
  vi.stubGlobal("fetch", stubFetch);
  ({ buildServer } = await import("../src/api/server.js"));
});

/** Drives /oauth/authorize -> Google callback and returns the redirect the
 * server answers with, without going through consent. */
async function attemptSignIn(email: string) {
  currentEmail = email;
  const app = buildServer({ fetchImpl: stubFetch as unknown as typeof fetch });
  await app.ready();
  const verifier = makeVerifier();
  const authorize = await app.inject({
    method: "GET",
    url: "/oauth/authorize",
    query: {
      client_id: `${ISSUER}/account`,
      redirect_uri: `${ISSUER}/account/callback`,
      response_type: "code",
      code_challenge: challengeFor(verifier),
      code_challenge_method: "S256",
      scope: "seerr:read",
    },
  });
  const googleUrl = new URL(authorize.headers.location as string);
  lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;

  const callback = await app.inject({
    method: "GET",
    url: "/oauth/google/callback",
    query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
  });
  await app.close();
  return callback;
}

describe("open signup", () => {
  it("denies an unlisted address when the flag is unset", async () => {
    const callback = await attemptSignIn(STRANGER_EMAIL);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location as string).toContain("error=access_denied");
  });

  it("admits an unlisted address once SEERRSENSE_OPEN_SIGNUP is true", async () => {
    process.env.SEERRSENSE_OPEN_SIGNUP = "true";
    const callback = await attemptSignIn(STRANGER_EMAIL);
    delete process.env.SEERRSENSE_OPEN_SIGNUP;
    // Reaches the consent screen rather than being redirected away.
    expect(callback.statusCode).toBe(200);
    expect(callback.payload).toContain("Authorize");
  });

  it.each(["TRUE", "1", "yes"])("treats %j as closed", async (value) => {
    process.env.SEERRSENSE_OPEN_SIGNUP = value;
    const callback = await attemptSignIn(STRANGER_EMAIL);
    delete process.env.SEERRSENSE_OPEN_SIGNUP;
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location as string).toContain("error=access_denied");
  });

  it("still admits nobody when the flag is off and the allowlist is empty", async () => {
    const previous = process.env.SEERRSENSE_ALLOWED_EMAILS;
    process.env.SEERRSENSE_ALLOWED_EMAILS = "";
    const callback = await attemptSignIn(ALLOWED_EMAIL);
    process.env.SEERRSENSE_ALLOWED_EMAILS = previous;
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location as string).toContain("error=access_denied");
  });

  it("keeps admitting a listed address when the flag is off", async () => {
    const callback = await attemptSignIn(ALLOWED_EMAIL);
    expect(callback.statusCode).toBe(200);
    expect(callback.payload).toContain("Authorize");
  });
});
