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
  // Mirrors createDefaultSeerrClient's own rule (undefined without
  // SEERR_API_KEY), so a test can turn the household instance off the same
  // way an operator would, without a real SeerrClient dialling anything.
  createDefaultSeerrClient: () => (process.env.SEERR_API_KEY ? householdSeerr : undefined),
}));

const ISSUER = "https://seerrsense.test";
const ALLOWED_EMAIL = "owner@example.com";
// Allowed to sign in, but never listed in SEERRSENSE_HOUSEHOLD_EMAILS.
const STRANGER_EMAIL = "stranger@example.com";
const ENCRYPTION_KEY = randomBytes(32).toString("hex");

let signPrivateKey: CryptoKey;
let googleJwks: { keys: unknown[] };
let lastGoogleNonce: string | undefined;
/** The address Google reports back for the next sign-in. */
let currentEmail = ALLOWED_EMAIL;
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
    const idToken = await new SignJWT({ email: currentEmail, email_verified: true, nonce: lastGoogleNonce })
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
  // A Seerr sitting behind Cloudflare Access: answers every request with a
  // redirect to the Zero Trust login host.
  if (url.startsWith("https://behind-access.example")) {
    seerrCalls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(null, {
      status: 302,
      headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/xyz" },
    });
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
  process.env.SEERRSENSE_ALLOWED_EMAILS = `${ALLOWED_EMAIL},${STRANGER_EMAIL}`;
  process.env.SEERRSENSE_ENCRYPTION_KEY = ENCRYPTION_KEY;
  // Fails closed otherwise: the SSRF guard's household-ownership restriction
  // (issue #44) would take the shared instance away from every test here that
  // relies on the pre-attachment fallback.
  process.env.SEERRSENSE_HOUSEHOLD_EMAILS = ALLOWED_EMAIL;
  // SeerrClient talks through the global fetch, so the stub has to be global as
  // well as injected: the credential check is a real call to the user's Seerr.
  vi.stubGlobal("fetch", stubFetch);
  ({ buildServer } = await import("../src/api/server.js"));
});

/** Stands in for the SSRF guard's DNS lookup, so a test hostname like
 * "mine.example" resolves to a public, non-blocked address instead of
 * hitting real DNS. */
const publicLookup = async () => ["93.184.216.34"];

async function makeApp() {
  const app = buildServer({ fetchImpl: stubFetch as unknown as typeof fetch, lookup: publicLookup });
  await app.ready();
  return app;
}

/** Signs the browser in exactly as the page does, and returns its cookie. */
async function signIn(app: any, email: string = ALLOWED_EMAIL): Promise<string> {
  currentEmail = email;
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
async function mcpTokenFor(app: any, email: string = ALLOWED_EMAIL): Promise<string> {
  return (await mcpGrantFor(app, email)).access_token;
}

/** The whole token response: access token and the refresh token that outlives it. */
async function mcpGrantFor(app: any, email: string = ALLOWED_EMAIL): Promise<{ access_token: string; refresh_token: string }> {
  currentEmail = email;
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
  return JSON.parse(token.payload);
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

  it("delivers the address as JSON, never rendered into the page's HTML", async () => {
    // Cloudflare's Email Address Obfuscation only rewrites addresses it finds
    // in an HTML response body. This page is static and gets the address from
    // the JSON API, writing it into the DOM with textContent after load — so
    // the origin never renders it as HTML and obfuscation cannot touch it.
    const app = await makeApp();
    const cookie = await signIn(app);

    const api = await app.inject({
      method: "GET",
      url: "/api/v1/account/connection",
      headers: { cookie },
    });
    expect(api.statusCode).toBe(200);
    expect(api.headers["content-type"]).toContain("application/json");
    // Asserting the body carries the address, not just that the response is
    // JSON: dropping `email` from the payload would leave the checks around
    // this one green — more comfortably, since the address is then nowhere at
    // all — while the page renders "Signed in as undefined".
    expect(JSON.parse(api.payload)).toMatchObject({ email: ALLOWED_EMAIL });

    const page = await app.inject({ method: "GET", url: "/account", headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.payload).not.toContain(ALLOWED_EMAIL);
    expect(page.payload).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
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
      ["cfAccessConfigured", "connected", "email", "fallback", "seerrUrl", "updatedAt"],
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
    // Untrusted (per-user) dials raise a typed SeerrUnreachableError, mapped to
    // a generic message that carries no upstream status: see guard.ts and
    // client.ts's fetchUntrusted.
    expect(JSON.parse(response.payload).error).toContain("Could not reach that Seerr");

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

  it("refuses a blocked address before any network call is made", async () => {
    const app = await makeApp();
    const cookie = await signIn(app);
    seerrCalls = [];

    for (const seerrUrl of [
      "http://media.example.com",
      "https://10.0.0.1",
      "https://169.254.169.254",
      "https://[::1]",
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/account/connection",
        headers: { cookie },
        payload: { seerrUrl, apiKey: "my-key" },
      });
      expect(response.statusCode, seerrUrl).toBe(400);
    }
    // Not one of the blocked addresses ever reached a fetch call.
    expect(seerrCalls).toEqual([]);
    await app.close();
  });

  it("answers 400 with a typo hint when the address does not resolve", async () => {
    // Regression: dns.lookup throws for a name outside the DNS instead of
    // returning nothing, the raw system error escaped the guard, and the
    // account page showed "internal error" — a 500 — for a mistyped address.
    // Seen in the browser against production on 2026-09-11.
    const enotfound = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND typo.example"), { code: "ENOTFOUND" });
    };
    const app = buildServer({ fetchImpl: stubFetch as unknown as typeof fetch, lookup: enotfound });
    await app.ready();
    const cookie = await signIn(app);
    seerrCalls = [];

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/account/connection",
      headers: { cookie },
      payload: { seerrUrl: "https://typo.example", apiKey: "my-key" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/did not resolve/);
    expect(response.json().error).not.toMatch(/internal/);
    // And it said so without dialling anything.
    expect(seerrCalls).toEqual([]);
    await app.close();
  });

  it("answers 503, not a typo hint, when the resolver itself is down", async () => {
    // EAI_AGAIN is cluster DNS wobbling. Telling the person their address is
    // wrong would send them hunting a typo that is not there, and a 400 would
    // tell a client never to retry.
    const servfail = async () => {
      throw Object.assign(new Error("getaddrinfo EAI_AGAIN mine.example"), { code: "EAI_AGAIN" });
    };
    const app = buildServer({ fetchImpl: stubFetch as unknown as typeof fetch, lookup: servfail });
    await app.ready();
    const cookie = await signIn(app);
    seerrCalls = [];

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/account/connection",
      headers: { cookie },
      payload: { seerrUrl: "https://mine.example", apiKey: "my-key" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json().error).toMatch(/Could not check that address/);
    expect(response.json().error).not.toMatch(/typo/);
    expect(seerrCalls).toEqual([]);
    await app.close();
  });

  it("answers 503 when the resolver goes down between the check and the dial", async () => {
    // describeSelf re-runs the guard with a cold memo, so a PUT resolves the
    // hostname twice. The resolver can answer the first and not the second;
    // that second failure must not come back as "check the address".
    let call = 0;
    const flaky = async () => {
      call += 1;
      if (call === 1) return ["93.184.216.34"];
      throw Object.assign(new Error("getaddrinfo EAI_AGAIN mine.example"), { code: "EAI_AGAIN" });
    };
    const app = buildServer({ fetchImpl: stubFetch as unknown as typeof fetch, lookup: flaky });
    await app.ready();
    const cookie = await signIn(app);

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/account/connection",
      headers: { cookie },
      payload: { seerrUrl: "https://mine.example", apiKey: "my-key" },
    });
    expect(call).toBeGreaterThan(1);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/Could not check that address/);
    await app.close();
  });

  it("names Cloudflare Access rather than the generic failure", async () => {
    const app = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/account/connection",
      headers: { cookie },
      payload: { seerrUrl: "https://behind-access.example", apiKey: "my-key" },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain("Cloudflare Access");
    expect(body.error).toContain("Zero Trust");
    // Neither the redirect target nor a status code leaks into the message.
    expect(body.error).not.toContain("cloudflareaccess.com");
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

describe("what the account page reports", () => {
  it("reports the household fallback for a listed address and none for a stranger", async () => {
    const app = await makeApp();

    const owner = await signIn(app, ALLOWED_EMAIL);
    const ownerBody = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/v1/account/connection", headers: { cookie: owner } })).payload,
    );
    expect(ownerBody.fallback).toBe("household");

    // Allowed to sign in, but SEERRSENSE_HOUSEHOLD_EMAILS never named this
    // address: the page must not promise the shared instance it cannot reach.
    const stranger = await signIn(app, STRANGER_EMAIL);
    const strangerBody = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/v1/account/connection", headers: { cookie: stranger } })).payload,
    );
    expect(strangerBody.fallback).toBe("none");

    await app.close();
  });

  it("reports none for every caller when no household client is configured", async () => {
    const previous = process.env.SEERR_API_KEY;
    delete process.env.SEERR_API_KEY;
    // The restore is in a finally because createDefaultSeerrClient reads this
    // at call time: leaking the deletion would build every later makeApp() in
    // this file with no household client, burying the real failure under
    // unrelated ones.
    try {
      const app = await makeApp();
      const cookie = await signIn(app, ALLOWED_EMAIL);

      const body = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/v1/account/connection", headers: { cookie } })).payload,
      );
      // A second copy of SEERRSENSE_HOUSEHOLD_EMAILS read in account.ts would
      // have told this listed address it has a shared instance that
      // createDefaultSeerrClient() never built.
      expect(body.fallback).toBe("none");

      await app.close();
    } finally {
      process.env.SEERR_API_KEY = previous;
    }
  });

  it("carries all three distinct status sentences and still branches on fallback", async () => {
    const app = await makeApp();
    const page = await app.inject({ method: "GET", url: "/account" });
    expect(page.statusCode).toBe(200);
    expect(page.payload).toContain("Connected to ");
    expect(page.payload).toContain("Using the shared Seerr until you attach your own.");
    expect(page.payload).toContain("No Seerr is connected yet");
    expect(page.payload).toContain("fallback");
    expect(page.payload).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    await app.close();
  });

  it("returns fallback from DELETE alongside connected: false, matching a follow-up GET", async () => {
    const app = await makeApp();
    const cookie = await signIn(app, ALLOWED_EMAIL);
    await app.inject({
      method: "PUT", url: "/api/v1/account/connection", headers: { cookie },
      payload: { seerrUrl: "https://mine.example", apiKey: "my-key" },
    });

    const deleted = await app.inject({ method: "DELETE", url: "/api/v1/account/connection", headers: { cookie } });
    const deletedBody = JSON.parse(deleted.payload);
    expect(deletedBody).toMatchObject({ connected: false, fallback: "household" });

    const after = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/v1/account/connection", headers: { cookie } })).payload,
    );
    expect(after.fallback).toBe(deletedBody.fallback);
    await app.close();
  });
});

describe("deleting the account", () => {
  it("removes the connection and every grant, ends the session, and answers 401 afterwards", async () => {
    const app = await makeApp();
    const cookie = await signIn(app, ALLOWED_EMAIL);
    seerrAnswers = { ok: true, body: { displayName: "Owner" } };
    const put = await app.inject({
      method: "PUT", url: "/api/v1/account/connection", headers: { cookie },
      payload: { seerrUrl: "https://mine.example", apiKey: "key-1" },
    });
    expect(put.statusCode, put.payload).toBe(200);
    // An assistant's grant for the same person, so deletion has something to
    // sign out; and a second browser, so it has a second session to end.
    const grant = await mcpGrantFor(app, ALLOWED_EMAIL);
    const otherDevice = await signIn(app, ALLOWED_EMAIL);
    // iat is whole seconds: let the second turn so the other device's cookie
    // is unambiguously older than the deletion.
    await new Promise((r) => setTimeout(r, 1100 - (Date.now() % 1000)));
    const refresh = () => app.inject({
      method: "POST", url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: grant.refresh_token, client_id: `${ISSUER}/account`,
      }).toString(),
    });

    const del = await app.inject({ method: "DELETE", url: "/api/v1/account", headers: { cookie } });
    expect(del.statusCode, del.payload).toBe(200);
    expect(JSON.parse(del.payload)).toEqual({ deleted: true });
    const setCookie = del.headers["set-cookie"] as string | string[];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(raw).toMatch(/Expires=|Max-Age=0/);

    // The session that asked is gone, and so is the other device's.
    expect((await app.inject({ method: "GET", url: "/api/v1/account/connection", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/account/connection", headers: { cookie: otherDevice } })).statusCode).toBe(401);
    // The assistant's grant is gone: the refresh token no longer redeems.
    const redeem = await refresh();
    expect(redeem.statusCode).toBe(400);
    expect(JSON.parse(redeem.payload).error).toBe("invalid_grant");
    // Signing in again finds no connection: the row was deleted, not hidden.
    const again = await signIn(app, ALLOWED_EMAIL);
    const after = await app.inject({ method: "GET", url: "/api/v1/account/connection", headers: { cookie: again } });
    expect(JSON.parse(after.payload).connected).toBe(false);
    await app.close();
  });

  it("refuses without a session, like the rest of the account API", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "DELETE", url: "/api/v1/account" })).statusCode).toBe(401);
    await app.close();
  });

  // The order is load-bearing: with the data gone first, another device's
  // still-valid cookie has one round trip in which to write a fresh
  // connection row for a subject who asked to be forgotten.
  it("ends every session before deleting the data", async () => {
    const { MemoryAuthStore } = await import("../src/auth/store.js");
    const store = new MemoryAuthStore();
    const order: string[] = [];
    for (const method of ["revokeSubjectSessions", "revokeSession", "deleteSubject"] as const) {
      const original = (store as any)[method].bind(store);
      (store as any)[method] = async (...args: unknown[]) => {
        order.push(method);
        return original(...args);
      };
    }
    const app = buildServer({ fetchImpl: stubFetch as unknown as typeof fetch, lookup: publicLookup, store });
    await app.ready();
    const cookie = await signIn(app, ALLOWED_EMAIL);
    expect((await app.inject({ method: "DELETE", url: "/api/v1/account", headers: { cookie } })).statusCode).toBe(200);
    // Exact, so a removed call fails too: indexOf(-1) would satisfy "less than".
    expect(order).toEqual(["revokeSubjectSessions", "revokeSession", "deleteSubject"]);
    await app.close();
  });

  // The route sits off the bearer gate because it authenticates with the
  // cookie; that must not become "or with a token". An assistant holding a
  // seerr:read grant must not be able to delete its owner's account.
  it("does not accept an MCP access token, in the header or pasted into the cookie", async () => {
    const app = await makeApp();
    const accessToken = await mcpTokenFor(app, ALLOWED_EMAIL);
    expect((await app.inject({
      method: "DELETE", url: "/api/v1/account", headers: { authorization: `Bearer ${accessToken}` },
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "DELETE", url: "/api/v1/account", headers: { cookie: `seerrsense_session=${accessToken}` },
    })).statusCode).toBe(401);
    await app.close();
  });

  // A cookie with no iat cannot be placed relative to the deletion, so it is
  // refused once its subject has ever been deleted.
  it("refuses a pre-jti cookie for a subject that was deleted", async () => {
    const app = await makeApp();
    const cookie = await signIn(app, ALLOWED_EMAIL);
    expect((await app.inject({ method: "DELETE", url: "/api/v1/account", headers: { cookie } })).statusCode).toBe(200);
    const legacy = await new SignJWT({ email: ALLOWED_EMAIL })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(`${ISSUER}/account`)
      .setSubject("google:google-sub-1")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode("x".repeat(48)));
    const response = await app.inject({
      method: "GET", url: "/api/v1/account/connection", headers: { cookie: `seerrsense_session=${legacy}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  // Google's subject is stable across deletions, and deletion clears the
  // resolve counter, so an unmetered route would be a daily budget reset.
  it("is metered per IP like the connection PUT", async () => {
    const app = await makeApp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await app.inject({ method: "DELETE", url: "/api/v1/account" })).statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    await app.close();
  });

  it("is offered on the page, behind a second click", async () => {
    const app = await makeApp();
    const { payload } = await app.inject({ method: "GET", url: "/account" });
    expect(payload).toContain('id="delete-account"');
    expect(payload).toContain('id="delete-confirm"');
    expect(payload).not.toContain("confirm(");
    await app.close();
  });
});

describe("signing out", () => {
  it("clears the session cookie with the same attributes it was set with", async () => {
    const app = await makeApp();
    const cookie = await signIn(app, ALLOWED_EMAIL);

    const response = await app.inject({ method: "DELETE", url: "/api/v1/account/session", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers["set-cookie"] as string | string[];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(raw).toContain("Path=/");
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    // ISSUER is https, so the cookie was set Secure and must be cleared
    // Secure too — a clear whose attributes differ sets a second cookie and
    // leaves the original in place. Dropping `secure` from clearCookie must
    // fail here.
    expect(raw).toContain("Secure");
    // Cleared, not merely re-set: the browser is told to drop it.
    expect(raw).toMatch(/Expires=|Max-Age=0/);

    await app.close();
  });

  it("ends the session: the old cookie is refused afterwards", async () => {
    const app = await makeApp();
    const cookie = await signIn(app, ALLOWED_EMAIL);

    await app.inject({ method: "DELETE", url: "/api/v1/account/session", headers: { cookie } });
    const replay = await app.inject({ method: "GET", url: "/api/v1/account/connection", headers: { cookie } });
    expect(replay.statusCode).toBe(401);

    await app.close();
  });

  it("does not touch MCP grants: a refresh token still redeems after sign-out", async () => {
    const app = await makeApp();
    const cookie = await signIn(app, ALLOWED_EMAIL);

    const verifier = makeVerifier();
    const authorize = await app.inject({
      method: "GET", url: "/oauth/authorize",
      query: {
        client_id: `${ISSUER}/account`, redirect_uri: `${ISSUER}/account/callback`,
        response_type: "code", code_challenge: challengeFor(verifier),
        code_challenge_method: "S256", scope: "seerr:read offline_access",
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
    const refreshToken = JSON.parse(token.payload).refresh_token;
    expect(refreshToken).toBeTruthy();

    await app.inject({ method: "DELETE", url: "/api/v1/account/session", headers: { cookie } });

    const refreshed = await app.inject({
      method: "POST", url: "/oauth/token",
      payload: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: `${ISSUER}/account` },
    });
    expect(refreshed.statusCode, refreshed.payload).toBe(200);
    expect(JSON.parse(refreshed.payload).access_token).toBeTruthy();

    await app.close();
  });

  it("leaves user_connections alone: signing in again after sign-out still reports the connection", async () => {
    const app = await makeApp();
    const cookie = await signIn(app, ALLOWED_EMAIL);
    await app.inject({
      method: "PUT", url: "/api/v1/account/connection", headers: { cookie },
      payload: { seerrUrl: "https://mine.example", apiKey: "my-key" },
    });

    await app.inject({ method: "DELETE", url: "/api/v1/account/session", headers: { cookie } });

    const secondCookie = await signIn(app, ALLOWED_EMAIL);
    const body = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/v1/account/connection", headers: { cookie: secondCookie } }))
        .payload,
    );
    expect(body).toMatchObject({ connected: true, seerrUrl: "https://mine.example" });

    await app.close();
  });

  it("is idempotent and self-authenticating", async () => {
    const app = await makeApp();

    // No cookie at all.
    const noCookie = await app.inject({ method: "DELETE", url: "/api/v1/account/session" });
    expect(noCookie.statusCode).toBe(200);

    // A cookie that does not decode as a session.
    const badCookie = await app.inject({
      method: "DELETE", url: "/api/v1/account/session", headers: { cookie: "seerrsense_session=garbage" },
    });
    expect(badCookie.statusCode).toBe(200);

    // Twice in a row with a real cookie.
    const cookie = await signIn(app, ALLOWED_EMAIL);
    const first = await app.inject({ method: "DELETE", url: "/api/v1/account/session", headers: { cookie } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "DELETE", url: "/api/v1/account/session", headers: { cookie } });
    expect(second.statusCode).toBe(200);

    // An MCP access token, in the header or pasted into the cookie, acts on
    // no session — the audience mismatch that already refuses it elsewhere.
    const accessToken = await mcpTokenFor(app, ALLOWED_EMAIL);
    const viaHeader = await app.inject({
      method: "DELETE", url: "/api/v1/account/session", headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(viaHeader.statusCode).toBe(200);
    const viaCookie = await app.inject({
      method: "DELETE", url: "/api/v1/account/session", headers: { cookie: `seerrsense_session=${accessToken}` },
    });
    expect(viaCookie.statusCode).toBe(200);

    await app.close();
  });

  it("is not reachable as a GET", async () => {
    const app = await makeApp();
    const cookie = await signIn(app, ALLOWED_EMAIL);
    const response = await app.inject({ method: "GET", url: "/api/v1/account/session", headers: { cookie } });
    expect(response.headers["set-cookie"]).toBeUndefined();
    // Fastify answers 404 for an unregistered method on a known prefix; either
    // way, the session must still verify afterwards.
    expect(response.statusCode).not.toBe(200);
    const still = await app.inject({ method: "GET", url: "/api/v1/account/connection", headers: { cookie } });
    expect(still.statusCode).toBe(200);
    await app.close();
  });

  it("still accepts a session cookie issued before sessions carried a jti", async () => {
    const app = await makeApp();
    // Hand-built exactly as issueSession built cookies before this change:
    // same claims, same signing key, no jti.
    const legacy = await new SignJWT({ email: ALLOWED_EMAIL })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(`${ISSUER}/account`)
      .setSubject("google:pre-jti")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode("x".repeat(48)));

    const response = await app.inject({
      method: "GET", url: "/api/v1/account/connection", headers: { cookie: `seerrsense_session=${legacy}` },
    });
    expect(response.statusCode).toBe(200);

    // And sign-out still clears it, even with nothing to revoke server-side.
    const signOut = await app.inject({
      method: "DELETE", url: "/api/v1/account/session", headers: { cookie: `seerrsense_session=${legacy}` },
    });
    expect(signOut.statusCode).toBe(200);

    await app.close();
  });
});
