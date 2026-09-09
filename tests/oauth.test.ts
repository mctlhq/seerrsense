import { describe, it, expect, beforeAll, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";

const SIGNING_KEY = new TextEncoder().encode("x".repeat(48));
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

// The household Seerr. Both the singleton and the factory are stubbed:
// the server builds its default client through the factory now.
const householdSeerr = vi.hoisted(() => ({
  status: vi.fn().mockResolvedValue({ status: 200 }),
    search: vi.fn().mockResolvedValue([]),
    getMedia: vi.fn().mockResolvedValue({ id: 1, mediaType: "movie", title: "T", status: "UNKNOWN" }),
    requestMedia: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../src/providers/seerr/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/seerr/client.js")>()),
  seerrClient: householdSeerr,
  createDefaultSeerrClient: () => householdSeerr,
}));

const ISSUER = "https://seerrsense.test";
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT_ID = "https://client.test/oauth/client.json";
const REDIRECT_URI = "http://127.0.0.1:33418/callback";
const ALLOWED_EMAIL = "owner@example.com";

let signPrivateKey: CryptoKey;
let googleJwks: { keys: unknown[] };
/** Set per test to control the identity Google reports back. */
let googleIdentity = { sub: "google-sub-1", email: ALLOWED_EMAIL, email_verified: true };
let clientDocument: Record<string, unknown>;
let lastGoogleNonce: string | undefined;

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
function makeVerifier(): string {
  return base64url(randomBytes(48)).slice(0, 64);
}

/** Stands in for Google and for the client's metadata document. */
async function stubFetch(input: any, init?: any): Promise<Response> {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // Serve whichever document the current test has staged, at its own URL.
  if (url === CLIENT_ID || url === clientDocument.client_id) return json(clientDocument);
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
    const body = new URLSearchParams(String(init?.body));
    if (body.get("grant_type") !== "authorization_code") return json({ error: "bad" }, 400);
    const idToken = await new SignJWT({
      email: googleIdentity.email,
      email_verified: googleIdentity.email_verified,
      nonce: lastGoogleNonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience("google-client-id")
      .setSubject(googleIdentity.sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signPrivateKey);
    return json({ id_token: idToken, access_token: "google-access" });
  }
  throw new Error(`unexpected fetch in test: ${url}`);
}

let buildServer: typeof import("../src/api/server.js").buildServer;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signPrivateKey = pair.privateKey;
  googleJwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" }] };
  clientDocument = {
    client_id: CLIENT_ID,
    client_name: "Test MCP Client",
    redirect_uris: [REDIRECT_URI],
  };

  process.env.SEERRSENSE_PUBLIC_URL = ISSUER;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-client-secret";
  process.env.SEERRSENSE_OAUTH_JWT_SIGNING_KEY = "x".repeat(48);
  process.env.SEERRSENSE_ALLOWED_EMAILS = ALLOWED_EMAIL;
  ({ buildServer } = await import("../src/api/server.js"));
});

async function makeApp() {
  const app = buildServer({ fetchImpl: stubFetch as unknown as typeof fetch });
  await app.ready();
  return app;
}

/** Drives authorize → Google callback and stops with an unredeemed code. */
async function getAuthorizationCode(app: any, options: { scope?: string; verifier?: string } = {}) {
  const verifier = options.verifier ?? makeVerifier();
  const authorize = await app.inject({
    method: "GET",
    url: "/oauth/authorize",
    query: {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: challengeFor(verifier),
      code_challenge_method: "S256",
      state: "client-state",
      scope: options.scope ?? "seerr:read seerr:request",
      resource: RESOURCE,
    },
  });
  expect(authorize.statusCode).toBe(302);
  const googleUrl = new URL(authorize.headers.location as string);
  lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;
  const state = googleUrl.searchParams.get("state")!;

  const consent = await app.inject({
    method: "GET",
    url: "/oauth/google/callback",
    query: { code: "google-code", state },
  });
  expect(consent.statusCode).toBe(200);
  const back = new URL(await approveConsent(app, consent.payload));
  expect(back.searchParams.get("state")).toBe("client-state");
  expect(back.searchParams.get("iss")).toBe(ISSUER);
  const code = back.searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code!, verifier, googleUrl };
}

/** Pulls the handle out of the rendered consent form and answers it. */
function consentHandle(html: string): string {
  const match = html.match(/name="code" value="([^"]+)"/);
  expect(match, "consent page carried no handle").toBeTruthy();
  return match![1];
}

async function answerConsent(app: any, html: string, decision: "allow" | "deny") {
  return app.inject({
    method: "POST",
    url: "/oauth/consent",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ code: consentHandle(html), decision }).toString(),
  });
}

async function approveConsent(app: any, html: string): Promise<string> {
  const response = await answerConsent(app, html, "allow");
  expect(response.statusCode).toBe(302);
  return response.headers.location as string;
}

/** The whole flow, ending with the token response. */
async function runFlow(app: any, options: { scope?: string; verifier?: string } = {}) {
  const { code, verifier, googleUrl } = await getAuthorizationCode(app, options);
  const token = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    },
  });
  return { token, verifier, googleUrl, code };
}

describe("discovery documents", () => {
  it("serves both well-known documents without a token", async () => {
    const app = await makeApp();
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.resource).toBe(RESOURCE);
      expect(body.authorization_servers).toEqual([ISSUER]);
    }
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.issuer).toBe(ISSUER);
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      // CIMD is the registration path; DCR is deprecated and not offered.
      expect(body.client_id_metadata_document_supported).toBe(true);
      expect(body.registration_endpoint).toBeUndefined();
      expect(body.scopes_supported).toEqual(["seerr:read", "seerr:request", "offline_access"]);
    }
    await app.close();
  });

  it("challenges an unauthenticated /mcp with resource_metadata", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(response.statusCode).toBe(401);
    const challenge = response.headers["www-authenticate"] as string;
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );
    await app.close();
  });

  it("labels a non-Bearer scheme as invalid_request", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search?query=x",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain('error="invalid_request"');
    await app.close();
  });
});

describe("authorization code flow", () => {
  it("issues a usable access token and accepts it on /mcp", async () => {
    const app = await makeApp();
    const { token } = await runFlow(app);
    expect(token.statusCode).toBe(200);
    const body = JSON.parse(token.payload);
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("seerr:read seerr:request");
    expect(body.refresh_token).toBeTruthy();
    expect(token.headers["cache-control"]).toBe("no-store");

    const tools = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${body.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.payload).toContain("search_media");
    await app.close();
  });

  it("rejects a code_verifier that does not match the challenge", async () => {
    const app = await makeApp();
    const { code } = await getAuthorizationCode(app, { scope: "seerr:read" });
    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: makeVerifier(),
      },
    });
    expect(token.statusCode).toBe(400);
    expect(JSON.parse(token.payload).error).toBe("invalid_grant");
    await app.close();
  });

  it("refuses to reuse an authorization code", async () => {
    const app = await makeApp();
    const verifier = makeVerifier();
    const { token, code } = await runFlow(app, { verifier });
    expect(JSON.parse(token.payload).access_token).toBeTruthy();

    // The same code, the same verifier, the same client: only single-use
    // consumption can make this fail.
    const replay = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      },
    });
    expect(replay.statusCode).toBe(400);
    expect(JSON.parse(replay.payload).error).toBe("invalid_grant");
    await app.close();
  });

  it("refuses a code redeemed against a different redirect_uri", async () => {
    const app = await makeApp();
    clientDocument = {
      client_id: CLIENT_ID,
      client_name: "Test MCP Client",
      redirect_uris: [REDIRECT_URI, "http://127.0.0.1:33419/callback"],
    };
    const verifier = makeVerifier();
    // The code must still be unredeemed, or this would fail because it was
    // already consumed rather than because the redirect_uri differs.
    const { code } = await getAuthorizationCode(app, { verifier });
    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:33419/callback",
        client_id: CLIENT_ID,
        code_verifier: verifier,
      },
    });
    expect(token.statusCode).toBe(400);
    expect(JSON.parse(token.payload).error).toBe("invalid_grant");
    clientDocument = { client_id: CLIENT_ID, client_name: "Test MCP Client", redirect_uris: [REDIRECT_URI] };
    await app.close();
  });

  it("refuses an id_token whose nonce does not match the pending login", async () => {
    const app = await makeApp();
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
        state: "client-state",
      },
    });
    const googleUrl = new URL(authorize.headers.location as string);
    // Google answers with an id_token minted for some other login.
    lastGoogleNonce = "a-nonce-from-another-login";
    const callback = await app.inject({
      method: "GET",
      url: "/oauth/google/callback",
      query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
    });
    const back = new URL(callback.headers.location as string);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    await app.close();
  });

  it("refuses a state that was already consumed", async () => {
    const app = await makeApp();
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    const googleUrl = new URL(authorize.headers.location as string);
    lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;
    const state = googleUrl.searchParams.get("state")!;
    const first = await app.inject({
      method: "GET",
      url: "/oauth/google/callback",
      query: { code: "google-code", state },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "GET",
      url: "/oauth/google/callback",
      query: { code: "google-code", state },
    });
    expect(second.statusCode).toBe(400);
    await app.close();
  });

  it("refuses a redirect_uri the client document does not list", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: "http://127.0.0.1:33418/callback.evil.test",
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toBe("invalid_request");
    await app.close();
  });

  it("refuses a resource other than its own", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
        resource: "https://someone-else.test/mcp",
        state: "s",
      },
    });
    expect(response.statusCode).toBe(302);
    expect(new URL(response.headers.location as string).searchParams.get("error")).toBe(
      "invalid_target",
    );
    await app.close();
  });
});

describe("public web surface", () => {
  it("leaves the landing-page paths open and everything else closed", async () => {
    const app = await makeApp();
    // The web surface must never meet the token gate...
    for (const path of ["/", "/favicon.svg", "/og.png", "/assets/tokens.css"]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(200);
    }
    // ...and "/" must not be a prefix that opens everything beneath it.
    for (const path of ["/api/v1/search?query=x", "/mcp"]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(401);
    }
    await app.close();
  });
});

describe("token endpoint encoding", () => {
  it("accepts the form-encoded token request that real clients send", async () => {
    const app = await makeApp();
    const { code, verifier } = await getAuthorizationCode(app);
    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    const body = JSON.parse(token.payload);
    expect(body.access_token).toBeTruthy();

    const revoke = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: body.refresh_token }).toString(),
    });
    expect(revoke.statusCode).toBe(200);
    await app.close();
  });
});

describe("access token validation", () => {
  it("refuses a token minted for another resource", async () => {
    const app = await makeApp();
    // Correctly signed by this server's key, but audienced at someone else's
    // MCP endpoint: a token stolen from another resource must not work here.
    const foreign = await new SignJWT({ scope: "seerr:read", client_id: CLIENT_ID, email: ALLOWED_EMAIL })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(ISSUER)
      .setAudience("https://someone-else.test/mcp")
      .setSubject("google:google-sub-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(SIGNING_KEY);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search?query=x",
      headers: { authorization: `Bearer ${foreign}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("refuses a token signed with the wrong key", async () => {
    const app = await makeApp();
    const forged = await new SignJWT({ scope: "seerr:read", client_id: CLIENT_ID, email: ALLOWED_EMAIL })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setSubject("google:intruder")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("y".repeat(48)));

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search?query=x",
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("refuses to redeem a code with a different client_id", async () => {
    const app = await makeApp();
    const { code, verifier } = await getAuthorizationCode(app);
    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: "https://other-client.test/client.json",
        code_verifier: verifier,
      },
    });
    expect(token.statusCode).toBe(400);
    expect(JSON.parse(token.payload).error).toBe("invalid_grant");
    await app.close();
  });
});

describe("consent", () => {
  it("names the client and the redirect host before granting anything", async () => {
    const app = await makeApp();
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
        scope: "seerr:read seerr:request",
      },
    });
    const googleUrl = new URL(authorize.headers.location as string);
    lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;
    const consent = await app.inject({
      method: "GET",
      url: "/oauth/google/callback",
      query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
    });

    expect(consent.statusCode).toBe(200);
    expect(consent.headers["content-type"]).toContain("text/html");
    // The redirect host is what the MCP spec requires to be visible: a loopback
    // client cannot be told apart from an impostor by anything else.
    expect(consent.payload).toContain("127.0.0.1:33418");
    expect(consent.payload).toContain("Test MCP Client");
    expect(consent.payload).toContain(ALLOWED_EMAIL);
    expect(consent.payload).toContain("Request new films");
    // form-action must reach the client's host or the button does nothing.
    expect(consent.headers["content-security-policy"]).toContain("form-action 'self' https:");
    await app.close();
  });

  it("carries no style the browser will drop, and links only stylesheets that exist", async () => {
    const app = await makeApp();
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
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
    expect(consent.statusCode).toBe(200);

    // style-src 'self' forbids an inline block. The failure is silent — the
    // linked sheets still load, so the page keeps its colours and merely loses
    // its layout, which is how it reached production looking broken.
    // Compared as a whole directive, not as a substring: "style-src 'self'"
    // occurs inside "style-src 'self' 'unsafe-inline'" too, and that spelling
    // would permit exactly what this case exists to forbid.
    const directives = String(consent.headers["content-security-policy"])
      .split(";")
      .map((directive) => directive.trim());
    expect(directives).toContain("style-src 'self'");
    expect(consent.payload).not.toMatch(/<style[\s>]/);
    expect(consent.payload).not.toMatch(/\sstyle=/);

    // Every sheet it does link has to be on disk, or the layout is gone the
    // same way for a different reason.
    const hrefs = [...consent.payload.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
      .map((match) => match[1]);
    expect(hrefs).toContain("/assets/consent.css");
    for (const href of hrefs) {
      expect(existsSync(new URL(`../public${href}`, import.meta.url)), href).toBe(true);
    }
    await app.close();
  });

  it("wraps the signed-in address in email_off markers, exactly once", async () => {
    // Cloudflare's Email Address Obfuscation rewrites any bare address in the
    // HTML body into a placeholder, and this response's CSP has no script-src
    // to run the decoder that would normally restore it. The email_off
    // comment markers are the origin-side opt-out; if they were ever removed
    // the address would render as [email protected] in production even though
    // this test's ALLOWED_EMAIL check below would keep passing on its own.
    const app = await makeApp();
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
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
    expect(consent.statusCode).toBe(200);

    const openMarkers = consent.payload.match(/<!--email_off-->/g) ?? [];
    const closeMarkers = consent.payload.match(/<!--\/email_off-->/g) ?? [];
    expect(openMarkers).toHaveLength(1);
    expect(closeMarkers).toHaveLength(1);

    const regions = [...consent.payload.matchAll(/<!--email_off-->([\s\S]*?)<!--\/email_off-->/g)].map(
      (match) => match[1],
    );
    expect(regions.some((region) => region.includes(ALLOWED_EMAIL))).toBe(true);

    // Stripping the marked region must remove the address entirely — the
    // pre-existing toContain(ALLOWED_EMAIL) check above would still pass even
    // if the markers were deleted, so it alone cannot catch that regression.
    const withoutMarkedRegions = consent.payload.replace(
      /<!--email_off-->[\s\S]*?<!--\/email_off-->/g,
      "",
    );
    expect(withoutMarkedRegions).not.toContain(ALLOWED_EMAIL);
    await app.close();
  });

  it("escapes a client name instead of rendering it", async () => {
    const app = await makeApp();
    clientDocument = {
      client_id: CLIENT_ID,
      client_name: '<img src=x onerror="alert(1)">',
      redirect_uris: [REDIRECT_URI],
    };
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    const googleUrl = new URL(authorize.headers.location as string);
    lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;
    const consent = await app.inject({
      method: "GET",
      url: "/oauth/google/callback",
      query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
    });
    expect(consent.payload).not.toContain("<img src=x");
    expect(consent.payload).toContain("&lt;img src=x");
    clientDocument = { client_id: CLIENT_ID, client_name: "Test MCP Client", redirect_uris: [REDIRECT_URI] };
    await app.close();
  });

  it("issues nothing when the person declines", async () => {
    const app = await makeApp();
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
        state: "client-state",
      },
    });
    const googleUrl = new URL(authorize.headers.location as string);
    lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;
    const consent = await app.inject({
      method: "GET",
      url: "/oauth/google/callback",
      query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
    });

    const denied = await answerConsent(app, consent.payload, "deny");
    expect(denied.statusCode).toBe(302);
    const back = new URL(denied.headers.location as string);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("state")).toBe("client-state");
    await app.close();
  });

  it("answers a consent handle only once", async () => {
    const app = await makeApp();
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    const googleUrl = new URL(authorize.headers.location as string);
    lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;
    const consent = await app.inject({
      method: "GET",
      url: "/oauth/google/callback",
      query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
    });

    expect((await answerConsent(app, consent.payload, "allow")).statusCode).toBe(302);
    const replay = await answerConsent(app, consent.payload, "allow");
    expect(replay.statusCode).toBe(400);
    await app.close();
  });
});

describe("native clients", () => {
  const LOOPBACK_CLIENT = "https://loopback.test/client.json";

  it("accepts a loopback redirect on whatever port the client bound", async () => {
    const app = await makeApp();
    clientDocument = {
      client_id: LOOPBACK_CLIENT,
      client_name: "Claude Code",
      // Exactly what Claude Code publishes: no port, both spellings.
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    };
    for (const redirectUri of ["http://localhost:3118/callback", "http://127.0.0.1:51234/callback"]) {
      const response = await app.inject({
        method: "GET",
        url: "/oauth/authorize",
        query: {
          client_id: LOOPBACK_CLIENT,
          redirect_uri: redirectUri,
          response_type: "code",
          code_challenge: challengeFor(makeVerifier()),
          code_challenge_method: "S256",
        },
      });
      expect(response.statusCode, redirectUri).toBe(302);
      expect(response.headers.location, redirectUri).toContain("accounts.google.com");
    }
    clientDocument = { client_id: CLIENT_ID, client_name: "Test MCP Client", redirect_uris: [REDIRECT_URI] };
    await app.close();
  });

  it("does not let the port exception widen to path, host or scheme", async () => {
    const app = await makeApp();
    clientDocument = {
      client_id: LOOPBACK_CLIENT,
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    };
    const rejected = [
      "http://localhost:3118/callback/../evil",
      "http://localhost:3118/other",
      "http://evil.test:3118/callback",
      "https://localhost:3118/callback",
      "http://127.0.0.1.evil.test:3118/callback",
    ];
    for (const redirectUri of rejected) {
      const response = await app.inject({
        method: "GET",
        url: "/oauth/authorize",
        query: {
          client_id: LOOPBACK_CLIENT,
          redirect_uri: redirectUri,
          response_type: "code",
          code_challenge: challengeFor(makeVerifier()),
          code_challenge_method: "S256",
        },
      });
      expect(response.statusCode, redirectUri).toBe(400);
    }
    clientDocument = { client_id: CLIENT_ID, client_name: "Test MCP Client", redirect_uris: [REDIRECT_URI] };
    await app.close();
  });

  it("keeps localhost and 127.0.0.1 as distinct registrations", async () => {
    const app = await makeApp();
    // Ignoring the port must not slide into ignoring the host: a client that
    // registered only localhost has not registered the IP literal, and the two
    // are different origins to a browser.
    clientDocument = {
      client_id: LOOPBACK_CLIENT,
      client_name: "Localhost only",
      redirect_uris: ["http://localhost/callback"],
    };
    const accepted = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: LOOPBACK_CLIENT,
        redirect_uri: "http://localhost:3118/callback",
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    expect(accepted.statusCode).toBe(302);

    const refused = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: LOOPBACK_CLIENT,
        redirect_uri: "http://127.0.0.1:3118/callback",
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    expect(refused.statusCode).toBe(400);
    clientDocument = { client_id: CLIENT_ID, client_name: "Test MCP Client", redirect_uris: [REDIRECT_URI] };
    await app.close();
  });

  it("refuses a redirect_uri carrying userinfo", async () => {
    const app = await makeApp();
    // Listed by the client's own document, and still refused: half the parsers
    // in the world read this as a request to evil.test.
    clientDocument = {
      client_id: LOOPBACK_CLIENT,
      client_name: "Impostor",
      redirect_uris: ["https://evil.test@127.0.0.1/callback"],
    };
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: LOOPBACK_CLIENT,
        redirect_uri: "https://evil.test@127.0.0.1/callback",
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    expect(response.statusCode).toBe(400);
    clientDocument = { client_id: CLIENT_ID, client_name: "Test MCP Client", redirect_uris: [REDIRECT_URI] };
    await app.close();
  });
});

describe("scope and resource negotiation", () => {
  it("grants offline_access when a client asks for it", async () => {
    const app = await makeApp();
    const { token } = await runFlow(app, { scope: "seerr:read offline_access" });
    expect(token.statusCode).toBe(200);
    const body = JSON.parse(token.payload);
    expect(body.scope).toBe("seerr:read offline_access");
    expect(body.refresh_token).toBeTruthy();
    await app.close();
  });

  it("refuses a token request naming another resource", async () => {
    const app = await makeApp();
    const { code, verifier } = await getAuthorizationCode(app);
    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource: "https://someone-else.test/mcp",
      },
    });
    expect(token.statusCode).toBe(400);
    expect(JSON.parse(token.payload).error).toBe("invalid_target");
    await app.close();
  });

  it("accepts the resource it actually serves", async () => {
    const app = await makeApp();
    const { code, verifier } = await getAuthorizationCode(app);
    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource: RESOURCE,
      },
    });
    expect(token.statusCode).toBe(200);
    await app.close();
  });
});

describe("client identity", () => {
  it("refuses a metadata document whose client_id does not match its URL", async () => {
    const app = await makeApp();
    clientDocument = {
      client_id: "https://attacker.test/other.json",
      client_name: "Impostor",
      redirect_uris: [REDIRECT_URI],
    };
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toBe("invalid_client");
    clientDocument = { client_id: CLIENT_ID, client_name: "Test MCP Client", redirect_uris: [REDIRECT_URI] };
    await app.close();
  });

  it("refuses a client_id that is neither pre-registered nor an https URL", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: "some-made-up-client",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toBe("invalid_client");
    await app.close();
  });
});

describe("allowlist", () => {
  it("turns away a Google account that is not allowed", async () => {
    const app = await makeApp();
    googleIdentity = { sub: "google-sub-2", email: "stranger@example.com", email_verified: true };
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
        state: "client-state",
      },
    });
    const googleUrl = new URL(authorize.headers.location as string);
    lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;
    const callback = await app.inject({
      method: "GET",
      url: "/oauth/google/callback",
      query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
    });
    const back = new URL(callback.headers.location as string);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    googleIdentity = { sub: "google-sub-1", email: ALLOWED_EMAIL, email_verified: true };
    await app.close();
  });

  it("turns away an unverified Google email", async () => {
    const app = await makeApp();
    googleIdentity = { sub: "google-sub-1", email: ALLOWED_EMAIL, email_verified: false };
    const authorize = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: {
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: challengeFor(makeVerifier()),
        code_challenge_method: "S256",
      },
    });
    const googleUrl = new URL(authorize.headers.location as string);
    lastGoogleNonce = googleUrl.searchParams.get("nonce") ?? undefined;
    const callback = await app.inject({
      method: "GET",
      url: "/oauth/google/callback",
      query: { code: "google-code", state: googleUrl.searchParams.get("state")! },
    });
    expect(new URL(callback.headers.location as string).searchParams.get("error")).toBe(
      "access_denied",
    );
    googleIdentity = { sub: "google-sub-1", email: ALLOWED_EMAIL, email_verified: true };
    await app.close();
  });
});

describe("refresh tokens", () => {
  it("rotates on use and revokes the family when a rotated token is replayed", async () => {
    const app = await makeApp();
    const { token } = await runFlow(app);
    const first = JSON.parse(token.payload).refresh_token;

    const refreshed = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "refresh_token", refresh_token: first, client_id: CLIENT_ID },
    });
    expect(refreshed.statusCode).toBe(200);
    const second = JSON.parse(refreshed.payload).refresh_token;
    expect(second).not.toBe(first);

    // Replaying the rotated token means two holders; the family dies.
    const replay = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "refresh_token", refresh_token: first, client_id: CLIENT_ID },
    });
    expect(replay.statusCode).toBe(400);

    const afterRevocation = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "refresh_token", refresh_token: second, client_id: CLIENT_ID },
    });
    expect(afterRevocation.statusCode).toBe(400);
    await app.close();
  });

  it("revokes a refresh token on request and answers unknown tokens with 200", async () => {
    const app = await makeApp();
    const { token } = await runFlow(app);
    const refreshToken = JSON.parse(token.payload).refresh_token;

    expect((await app.inject({ method: "POST", url: "/oauth/revoke", payload: { token: refreshToken } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/oauth/revoke", payload: { token: "never-existed" } })).statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "refresh_token", refresh_token: refreshToken },
    });
    expect(afterRevoke.statusCode).toBe(400);
    await app.close();
  });
});

describe("scopes", () => {
  it("lets a seerr:read token search but not request", async () => {
    const app = await makeApp();
    const { token } = await runFlow(app, { scope: "seerr:read" });
    const accessToken = JSON.parse(token.payload).access_token;

    const call = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "request_media", arguments: { mediaType: "movie", tmdbId: 27205 } },
      },
    });
    expect(call.statusCode).toBe(200);
    expect(call.payload).toContain("seerr:request");

    const search = await app.inject({
      method: "GET",
      url: "/api/v1/search?query=inception",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(search.statusCode).toBe(200);
    await app.close();
  });

  it("lets a seerr:request token through the write tool", async () => {
    const app = await makeApp();
    const { token } = await runFlow(app, { scope: "seerr:read seerr:request" });
    const accessToken = JSON.parse(token.payload).access_token;
    const call = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "request_media", arguments: { mediaType: "movie", tmdbId: 27205 } },
      },
    });
    expect(call.statusCode).toBe(200);
    expect(call.payload).not.toContain("not granted");
    await app.close();
  });
});

describe("legacy token", () => {
  it("still works while it is enabled, and public paths keep their query strings", async () => {
    const app = await makeApp();
    const legacy = await app.inject({
      method: "GET",
      url: "/api/v1/search?query=inception",
      headers: { authorization: "Bearer secret123" },
    });
    expect(legacy.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/healthz?probe=1" })).statusCode).toBe(200);
    await app.close();
  });

  it("is refused once SEERRSENSE_LEGACY_TOKEN_ENABLED is false", async () => {
    process.env.SEERRSENSE_LEGACY_TOKEN_ENABLED = "false";
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search?query=inception",
      headers: { authorization: "Bearer secret123" },
    });
    expect(response.statusCode).toBe(401);
    delete process.env.SEERRSENSE_LEGACY_TOKEN_ENABLED;
    await app.close();
  });
});
