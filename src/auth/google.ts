import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { base64url, sha256 } from "./crypto.js";

const GOOGLE_ISSUER = "https://accounts.google.com";
const DISCOVERY_URL = `${GOOGLE_ISSUER}/.well-known/openid-configuration`;

interface GoogleDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export interface GoogleIdentity {
  subject: string;
  email: string;
}

/**
 * Google as the identity provider. seerrsense stays the authorization server;
 * Google only answers "who is this", which is what puts passkeys and 2FA on
 * Google's side instead of in this codebase.
 */
export class GoogleOidc {
  private discovery?: Promise<GoogleDiscovery>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async metadata(): Promise<GoogleDiscovery> {
    // Discovered rather than hardcoded, and memoised for the process lifetime.
    this.discovery ??= this.fetchImpl(DISCOVERY_URL, { signal: AbortSignal.timeout(5000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Google discovery returned ${response.status}`);
        return (await response.json()) as GoogleDiscovery;
      })
      .catch((error) => {
        this.discovery = undefined; // do not cache a failure
        throw error;
      });
    return this.discovery;
  }

  /** The upstream leg carries its own PKCE pair and nonce, independent of the client's. */
  async authorizationUrl(params: {
    state: string;
    codeVerifier: string;
    nonce: string;
    loginHint?: string;
  }): Promise<string> {
    const { authorization_endpoint } = await this.metadata();
    const url = new URL(authorization_endpoint);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    url.searchParams.set("code_challenge", base64url(sha256(params.codeVerifier)));
    url.searchParams.set("code_challenge_method", "S256");
    if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
    return url.toString();
  }

  async exchangeCode(code: string, codeVerifier: string, nonce: string): Promise<GoogleIdentity> {
    const { token_endpoint, jwks_uri } = await this.metadata();
    const response = await this.fetchImpl(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Google token endpoint returned ${response.status}`);
    }
    const body = (await response.json()) as { id_token?: string };
    if (!body.id_token) throw new Error("Google response carried no id_token");

    // The injected fetch reaches the JWKS retrieval too, so a test can serve
    // Google's keys without the process reaching the network.
    this.jwks ??= createRemoteJWKSet(new URL(jwks_uri), { [customFetch]: this.fetchImpl });
    const { payload } = await jwtVerify(body.id_token, this.jwks, {
      issuer: [GOOGLE_ISSUER, "accounts.google.com"],
      audience: this.clientId,
    });

    // nonce binds this id_token to the authorization request this process
    // started; without the check a token minted for another login would pass.
    if (payload.nonce !== nonce) throw new Error("Google id_token nonce did not match");
    const email = typeof payload.email === "string" ? payload.email : undefined;
    if (!email) throw new Error("Google id_token carried no email");
    if (payload.email_verified !== true) throw new Error("Google email is not verified");
    if (typeof payload.sub !== "string") throw new Error("Google id_token carried no sub");

    return { subject: payload.sub, email: email.toLowerCase() };
  }
}
