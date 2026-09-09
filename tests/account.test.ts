import { describe, it, expect, beforeAll, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { createHash, randomBytes } from "node:crypto";

const householdSeerr = vi.hoisted(() => ({
  status: vi.fn().mockResolvedValue({ status: 200 }),
  search: vi.fn().mockResolvedValue([]),
  getMedia: vi.fn(),
  requestMedia: vi.fn(),
  findUserIdByEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/providers/seerr/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/seerr/client.js")>()),
  seerrClient: householdSeerr,
  createDefaultSeerrClient: () => householdSeerr,
}));

const ISSUER = "https://seerrsense.test";
const ALLOWED_EMAIL = "owner@example.com";
const ENCRYPTION_KEY = randomBytes(32).toString("hex");

let signPrivateKey: CryptoKey;
let googleJwks: { keys: unknown[] };
let lastGoogleNonce: string | undefined;
/** What the user's own Seerr answers when its credentials are checked. */
let seerrAnswers: { ok: boolean; body?: unknown } = { ok: true, body: { displayName: "Owner" } };
let seerrCalls: Array<{ url: string; headers: Record<string, string> }> = [];

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
function makeVerifier(): string {
  return base64url(randomBytes(48)).slice(0, 64);
}

async function stubFetch(input: any, init?: any): Promise<Response> {
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
    const idToken = await new SignJWT({ email: ALLOWED_EMAIL, email_verified: true, nonce: lastGoogleNonce })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience("google-client-id")
      .setSubject("google-sub-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signPrivateKey);
    return json({ id_token: idToken });
  }
  // The person's own Seerr.
  if (url.startsWith("https://mine.example")) {
    seerrCalls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (!seerrAnswers.ok) return new Response("no", { status: 401 });
    return json(seerrAnswers.body);
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
  process.env.SEERRSENSE_ENCRYPTION_KEY = ENCRYPTION_KEY;
  // SeerrClient talks through the global fetch, so the stub has to be global as
  // well as injected: the credential check is a real call to the user's Seerr.
  vi.stubGlobal("fetch", stubFetch);
  ({ buildServer } = await import("../src/api/server.js"));
});

async function makeApp() {
  const app = buildServer({ fetchImpl: stubFetch as unknown as typeof fetch });
  await app.ready();
  return app;
}

/** Signs the browser in exactly as the page does, and returns its cookie. */
async function signIn(app: any): Promise<string> {
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

  const consent = await app.inject({
    method: "GET",
    url: "/oauth/google/callback",
    query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
  });
  const handle = consent.payload.match(/name="code" value="([^"]+)"/)![1];
  const granted = await app.inject({
    method: "POST",
    url: "/oauth/consent",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ code: handle, decision: "allow" }).toString(),
  });
  const code = new URL(granted.headers.location as string).searchParams.get("code")!;

  const session = await app.inject({
    method: "POST",
    url: "/account/session",
    payload: { code, codeVerifier: verifier },
  });
  expect(session.statusCode, session.payload).toBe(200);
  const cookie = (session.headers["set-cookie"] as string | string[]);
  const raw = Array.isArray(cookie) ? cookie[0] : cookie;
  expect(raw).toContain("HttpOnly");
  expect(raw).toContain("SameSite=Lax");
  return raw.split(";")[0];
}

/** A real MCP access token for the same person. */
async function mcpTokenFor(app: any): Promise<string> {
  const verifier = makeVerifier();
  const authorize = await app.inject({
    method: "GET", url: "/oauth/authorize",
    query: {
      client_id: `${ISSUER}/account`, redirect_uri: `${ISSUER}/account/callback`,
      response_type: "code", code_challenge: challengeFor(verifier),
      code_challenge_method: "S256", scope: "seerr:read",
    },
  });
  const googleUrl = new URL(authorize.headers.location as string);
  lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;
  const consent = await app.inject({
    method: "GET", url: "/oauth/google/callback",
    query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
  });
  const handle = consent.payload.match(/name="code" value="([^"]+)"/)![1];
  const granted = await app.inject({
    method: "POST", url: "/oauth/consent",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ code: handle, decision: "allow" }).toString(),
  });
  const code = new URL(granted.headers.location as string).searchParams.get("code")!;
  const token = await app.inject({
    method: "POST", url: "/oauth/token",
    payload: {
      grant_type: "authorization_code", code, redirect_uri: `${ISSUER}/account/callback`,
      client_id: `${ISSUER}/account`, code_verifier: verifier,
    },
  });
  return JSON.parse(token.payload).access_token;
}

describe("the account page", () => {
  it("is served without a token and shows nothing by itself", async () => {
    const app = await makeApp();
    const page = await app.inject({ method: "GET", url: "/account" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-store");
    // Every value on the page arrives from the API, which needs the cookie.
    expect(page.payload).not.toContain(ALLOWED_EMAIL);
    await app.close();
  });

  it("resolves its own client without fetching anything", async () => {
    // The page's client_id is an https URL with a path, which the resolver
    // would otherwise treat as a metadata document and fetch — from a path that
    // serves HTML. Production has no stub to save it, so the client is
    // registered in code and no request may be made for it.
    const fetched: string[] = [];
    const watchful = (async (input: any, init?: any) => {
      fetched.push(typeof input === "string" ? input : String(input));
      return stubFetch(input, init);
    }) as unknown as typeof fetch;

    const app = buildServer({ fetchImpl: watchful });
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: `${ISSUER}/account`,
        redirect_uri: `${ISSUER}/account/callback`,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    expect(response.statusCode).toBe(302);
    expect(fetched.filter((url) => url === `${ISSUER}/account`)).toEqual([]);
    await app.close();
  });

  it("says so plainly when this server cannot sign anybody in", async () => {
    // With no OAuth configured the account API is not registered at all. The
    // page must say that rather than render a form addressed to nobody — which
    // is what it did until a screenshot showed "Signed in as undefined".
    const previous = process.env.SEERRSENSE_PUBLIC_URL;
    delete process.env.SEERRSENSE_PUBLIC_URL;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.SEERRSENSE_OAUTH_JWT_SIGNING_KEY;
    const app = buildServer({ fetchImpl: stubFetch as unknown as typeof fetch });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/account" })).statusCode).toBe(200);
    const api = await app.inject({ method: "GET", url: "/api/v1/account/connection" });
    expect(api.statusCode).not.toBe(200);

    const page = await app.inject({ method: "GET", url: "/account" });
    // The page distinguishes "not signed in" from "cannot sign in".
    expect(page.payload).toContain("sign-in-note");
    expect(page.payload).toContain("Sign-in is not enabled on this server");

    await app.close();
    process.env.SEERRSENSE_PUBLIC_URL = previous;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-client-secret";
    process.env.SEERRSENSE_OAUTH_JWT_SIGNING_KEY = "x".repeat(48);
  });

  it("refuses the account API without a session", async () => {
    const app = await makeApp();
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/api/v1/account/connection", payload: {} });
      expect(response.statusCode, method).toBe(401);
    }
    await app.close();
  });

  it("does not accept an MCP access token in place of the session", async () => {
    const app = await makeApp();
    // An assistant holding a working MCP token must not be able to read or
    // rewrite which Seerr it talks to — not in the header, and not by pasting
    // the same token into the session cookie: the two are audienced apart.
    const accessToken = await mcpTokenFor(app);
    for (const headers of [
      { authorization: `Bearer ${accessToken}` },
      { cookie: `seerrsense_session=${accessToken}` },
    ]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/account/connection",
        headers,
      });
      expect(response.statusCode).toBe(401);
    }
    await app.close();
  });
});

describe("attaching a Seerr", () => {
  it("checks the credentials, stores them sealed, and reports who they belong to", async () => {
    const app = await makeApp();
    const cookie = await signIn(app);

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/account/connection",
      headers: { cookie },
    });
    expect(JSON.parse(before.payload)).toMatchObject({ email: ALLOWED_EMAIL, connected: false });

    seerrCalls = [];
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/account/connection",
      headers: { cookie },
      payload: { seerrUrl: "https://mine.example/", apiKey: "my-key" },
    });
    expect(saved.statusCode, saved.payload).toBe(200);
    expect(JSON.parse(saved.payload)).toMatchObject({
      connected: true,
      seerrUrl: "https://mine.example",
      seerrUser: "Owner",
    });
    // The check really talked to that Seerr with that key.
    expect(seerrCalls[0].url).toContain("/api/v1/auth/me");
    expect(seerrCalls[0].headers["X-Api-Key"]).toBe("my-key");

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/account/connection",
      headers: { cookie },
    });
    const body = JSON.parse(after.payload);
    expect(body).toMatchObject({ connected: true, seerrUrl: "https://mine.example" });
    // Neither the key nor its sealed form is handed back. Listing the allowed
    // fields rather than searching for the secret catches a sealed value too,
    // which a substring check would happily let through.
    expect(Object.keys(body).sort()).toEqual(
      ["cfAccessConfigured", "connected", "email", "seerrUrl", "updatedAt"],
    );
    await app.close();
  });

  it("takes effect immediately after saving, not when a cache expires", async () => {
    const app = await makeApp();
    const cookie = await signIn(app);
    const accessToken = await mcpTokenFor(app);

    // Warm the resolver with the household instance first: without clearing it
    // on save, the person would keep reaching the old Seerr for a minute.
    householdSeerr.search.mockClear();
    seerrAnswers = { ok: true, body: { results: [] } };
    await app.inject({
      method: "GET", url: "/api/v1/search?query=x",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(householdSeerr.search).toHaveBeenCalled();

    await app.inject({
      method: "PUT", url: "/api/v1/account/connection", headers: { cookie },
      payload: { seerrUrl: "https://mine.example", apiKey: "my-key" },
    });

    householdSeerr.search.mockClear();
    seerrCalls = [];
    await app.inject({
      method: "GET", url: "/api/v1/search?query=x",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(seerrCalls.some((call) => call.url.includes("/api/v1/search"))).toBe(true);
    expect(householdSeerr.search).not.toHaveBeenCalled();
    seerrAnswers = { ok: true, body: { displayName: "Owner" } };
    await app.close();
  });

  it("refuses credentials the Seerr itself rejects", async () => {
    const app = await makeApp();
    const cookie = await signIn(app);
    seerrAnswers = { ok: false };

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/account/connection",
      headers: { cookie },
      payload: { seerrUrl: "https://mine.example", apiKey: "wrong" },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toContain("did not accept");

    const state = await app.inject({
      method: "GET",
      url: "/api/v1/account/connection",
      headers: { cookie },
    });
    expect(JSON.parse(state.payload).connected).toBe(false);
    seerrAnswers = { ok: true, body: { displayName: "Owner" } };
    await app.close();
  });

  it("keeps the stored key when only the address changes", async () => {
    const app = await makeApp();
    const cookie = await signIn(app);
    await app.inject({
      method: "PUT", url: "/api/v1/account/connection", headers: { cookie },
      payload: { seerrUrl: "https://mine.example", apiKey: "my-key" },
    });

    seerrCalls = [];
    const moved = await app.inject({
      method: "PUT", url: "/api/v1/account/connection", headers: { cookie },
      payload: { seerrUrl: "https://mine.example/second", apiKey: "" },
    });
    expect(moved.statusCode).toBe(200);
    // Nobody had to re-type a secret they no longer have to hand.
    expect(seerrCalls[0].headers["X-Api-Key"]).toBe("my-key");
    await app.close();
  });

  it("requires a key the first time", async () => {
    const app = await makeApp();
    const cookie = await signIn(app);
    const response = await app.inject({
      method: "PUT", url: "/api/v1/account/connection", headers: { cookie },
      payload: { seerrUrl: "https://mine.example" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("routes the person's own tool calls to their Seerr, and disconnect returns them", async () => {
    const app = await makeApp();
    const cookie = await signIn(app);
    await app.inject({
      method: "PUT", url: "/api/v1/account/connection", headers: { cookie },
      payload: { seerrUrl: "https://mine.example", apiKey: "my-key" },
    });

    // Sign in again for an MCP token belonging to the same person.
    const verifier = makeVerifier();
    const authorize = await app.inject({
      method: "GET", url: "/oauth/authorize",
      query: {
        client_id: `${ISSUER}/account`, redirect_uri: `${ISSUER}/account/callback`,
        response_type: "code", code_challenge: challengeFor(verifier),
        code_challenge_method: "S256", scope: "seerr:read",
      },
    });
    const googleUrl = new URL(authorize.headers.location as string);
    lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;
    const consent = await app.inject({
      method: "GET", url: "/oauth/google/callback",
      query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
    });
    const handle = consent.payload.match(/name="code" value="([^"]+)"/)![1];
    const granted = await app.inject({
      method: "POST", url: "/oauth/consent",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ code: handle, decision: "allow" }).toString(),
    });
    const code = new URL(granted.headers.location as string).searchParams.get("code")!;
    const token = await app.inject({
      method: "POST", url: "/oauth/token",
      payload: {
        grant_type: "authorization_code", code, redirect_uri: `${ISSUER}/account/callback`,
        client_id: `${ISSUER}/account`, code_verifier: verifier,
      },
    });
    const accessToken = JSON.parse(token.payload).access_token;

    seerrCalls = [];
    householdSeerr.search.mockClear();
    seerrAnswers = { ok: true, body: { results: [] } };
    const search = await app.inject({
      method: "GET", url: "/api/v1/search?query=inception",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(search.statusCode).toBe(200);
    // Their instance was called; the household one was not.
    expect(seerrCalls.some((call) => call.url.includes("/api/v1/search"))).toBe(true);
    expect(householdSeerr.search).not.toHaveBeenCalled();

    // Disconnecting takes effect at once rather than after the cache expires.
    await app.inject({ method: "DELETE", url: "/api/v1/account/connection", headers: { cookie } });
    seerrCalls = [];
    await app.inject({
      method: "GET", url: "/api/v1/search?query=inception",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(householdSeerr.search).toHaveBeenCalled();
    seerrAnswers = { ok: true, body: { displayName: "Owner" } };
    await app.close();
  });
});
