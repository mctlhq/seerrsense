import { afterAll, describe, expect, it } from "vitest";
import {
  MemoryAuthStore,
  type AuthCode,
  type AuthStore,
  type PendingAuth,
  type RefreshRecord,
  type UserConnection,
} from "../src/auth/store.js";
import { PostgresAuthStore } from "../src/auth/store-pg.js";

/**
 * One suite, both stores.
 *
 * The OAuth tests all run on MemoryAuthStore, so every guard they prove is
 * proved against the store production does not use. PostgresAuthStore carries
 * every authorization code and refresh token the moment DATABASE_URL is set,
 * and until this file existed nothing exercised a single one of its queries —
 * a typo in a column name would have surfaced as a failed login in production.
 *
 * Postgres is only reachable when TEST_DATABASE_URL is set, so the suite runs
 * unattended in CI and against a real server locally:
 *
 *   docker run -d --name pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL='postgresql://postgres:test@127.0.0.1:55432/postgres?sslmode=disable' npm test
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;

const pending = (over: Partial<PendingAuth> = {}): PendingAuth => ({
  state: "state-1",
  clientId: "https://claude.ai/oauth/metadata",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  clientState: "client-state",
  codeChallenge: "challenge",
  scope: "seerr:read",
  resource: "https://seerrsense.mctl.ai/mcp",
  googleVerifier: "verifier",
  googleNonce: "nonce",
  expiresAt: Date.now() + 600_000,
  ...over,
});

const authCode = (over: Partial<AuthCode> = {}): AuthCode => ({
  code: "code-1",
  clientId: "https://claude.ai/oauth/metadata",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  clientState: "client-state",
  codeChallenge: "challenge",
  scope: "seerr:read seerr:request",
  resource: "https://seerrsense.mctl.ai/mcp",
  subject: "google:1",
  email: "someone@example.test",
  expiresAt: Date.now() + 60_000,
  ...over,
});

const refresh = (over: Partial<RefreshRecord> = {}): RefreshRecord => ({
  tokenHash: "hash-1",
  familyId: "family-1",
  clientId: "https://claude.ai/oauth/metadata",
  scope: "seerr:read",
  resource: "https://seerrsense.mctl.ai/mcp",
  subject: "google:1",
  email: "someone@example.test",
  expiresAt: Date.now() + 86_400_000,
  ...over,
});

const connection = (over: Partial<UserConnection> = {}): UserConnection => ({
  subject: "google:1",
  email: "someone@example.test",
  seerrUrl: "https://seerr.example.test",
  seerrApiKeySealed: "sealed-key",
  updatedAt: Date.now(),
  ...over,
});

const stores: [string, () => AuthStore][] = [
  ["MemoryAuthStore", () => new MemoryAuthStore()],
];
if (DATABASE_URL) {
  stores.push(["PostgresAuthStore", () => new PostgresAuthStore(DATABASE_URL)]);
} else {
  // Silence is how an integration suite quietly stops running. Say it out loud.
  console.warn("TEST_DATABASE_URL is not set — PostgresAuthStore is not exercised");
}

describe.each(stores)("%s", (name, make) => {
  const store = make();
  let ready: Promise<void> | undefined;
  // Every case gets its own key space so the shared Postgres does not carry
  // rows between them, and so the two stores can run the identical suite.
  let n = 0;
  const id = (prefix: string) => `${prefix}-${name}-${++n}-${Math.random().toString(36).slice(2)}`;

  async function fresh(): Promise<AuthStore> {
    ready ??= store.init();
    await ready;
    return store;
  }

  afterAll(async () => {
    if (ready) await store.close();
  });

  it("creates its schema idempotently", async () => {
    await fresh();
    // A second pod runs init() against the same database during a rollout.
    await expect(store.init()).resolves.toBeUndefined();
  });

  it("returns a pending login once and never again", async () => {
    await fresh();
    const state = id("state");
    await store.putPendingAuth(pending({ state }));
    const taken = await store.takePendingAuth(state);
    expect(taken?.clientState).toBe("client-state");
    expect(taken?.expiresAt).toBeTypeOf("number");
    expect(await store.takePendingAuth(state)).toBeUndefined();
  });

  it("carries the identity written on the second hop", async () => {
    await fresh();
    const state = id("state");
    await store.putPendingAuth(pending({ state, subject: "google:7", email: "a@b.test" }));
    const taken = await store.takePendingAuth(state);
    expect(taken?.subject).toBe("google:7");
    expect(taken?.email).toBe("a@b.test");
  });

  it("treats an absent clientState as absent, not as the string null", async () => {
    await fresh();
    const state = id("state");
    await store.putPendingAuth(pending({ state, clientState: undefined }));
    expect((await store.takePendingAuth(state))?.clientState).toBeUndefined();
  });

  it("refuses an expired pending login", async () => {
    await fresh();
    const state = id("state");
    await store.putPendingAuth(pending({ state, expiresAt: Date.now() - 1 }));
    expect(await store.takePendingAuth(state)).toBeUndefined();
  });

  it("returns an authorization code once", async () => {
    await fresh();
    const code = id("code");
    await store.putAuthCode(authCode({ code }));
    const taken = await store.takeAuthCode(code);
    expect(taken?.subject).toBe("google:1");
    expect(taken?.scope).toBe("seerr:read seerr:request");
    // Replaying a code is the attack RFC 6749 §4.1.2 names explicitly.
    expect(await store.takeAuthCode(code)).toBeUndefined();
  });

  it("refuses an expired authorization code", async () => {
    await fresh();
    const code = id("code");
    await store.putAuthCode(authCode({ code, expiresAt: Date.now() - 1 }));
    expect(await store.takeAuthCode(code)).toBeUndefined();
  });

  it("round-trips a refresh token and marks it consumed", async () => {
    await fresh();
    const tokenHash = id("hash");
    await store.putRefreshToken(refresh({ tokenHash }));
    expect((await store.getRefreshToken(tokenHash))?.consumedAt).toBeUndefined();
    await store.markRefreshConsumed(tokenHash);
    const consumed = await store.getRefreshToken(tokenHash);
    // Rotation detection reads this field; a null arriving as 0 or as the
    // string "null" would read as "already consumed" or as "never".
    expect(consumed?.consumedAt).toBeTypeOf("number");
    expect(consumed!.consumedAt!).toBeGreaterThan(0);
  });

  it("revokes a whole family at once", async () => {
    await fresh();
    const familyId = id("family");
    const first = id("hash");
    const second = id("hash");
    const other = id("hash");
    await store.putRefreshToken(refresh({ tokenHash: first, familyId }));
    await store.putRefreshToken(refresh({ tokenHash: second, familyId }));
    await store.putRefreshToken(refresh({ tokenHash: other, familyId: id("family") }));
    await store.revokeFamily(familyId);
    expect(await store.getRefreshToken(first)).toBeUndefined();
    expect(await store.getRefreshToken(second)).toBeUndefined();
    // Reuse of one login must not sign everybody else out.
    expect(await store.getRefreshToken(other)).toBeDefined();
  });

  it("revokes a single token", async () => {
    await fresh();
    const tokenHash = id("hash");
    await store.putRefreshToken(refresh({ tokenHash }));
    await store.revokeToken(tokenHash);
    expect(await store.getRefreshToken(tokenHash)).toBeUndefined();
  });

  it("sweeps expired OAuth state but never a connection", async () => {
    await fresh();
    const tokenHash = id("hash");
    const subject = id("google");
    await store.putRefreshToken(refresh({ tokenHash, expiresAt: Date.now() - 1 }));
    await store.putUserConnection(connection({ subject, updatedAt: 1 }));
    await store.purgeExpired();
    expect(await store.getRefreshToken(tokenHash)).toBeUndefined();
    // The one table nobody can recreate by signing in again.
    expect(await store.getUserConnection(subject)).toBeDefined();
  });

  it("round-trips a connection with every optional field absent", async () => {
    await fresh();
    const subject = id("google");
    const updatedAt = Date.now();
    await store.putUserConnection(connection({ subject, updatedAt }));
    const found = await store.getUserConnection(subject);
    expect(found).toMatchObject({
      subject,
      email: "someone@example.test",
      seerrUrl: "https://seerr.example.test",
      seerrApiKeySealed: "sealed-key",
      updatedAt,
    });
    // /account reports Cloudflare Access as configured by testing these for
    // undefined, so a null arriving as itself would claim it is set.
    expect(found?.cfAccessClientIdSealed).toBeUndefined();
    expect(found?.cfAccessClientSecretSealed).toBeUndefined();
    expect(found?.locale).toBeUndefined();
  });

  it("round-trips a connection with the Cloudflare Access pair", async () => {
    await fresh();
    const subject = id("google");
    await store.putUserConnection(
      connection({
        subject,
        locale: "ru-RU",
        cfAccessClientIdSealed: "sealed-id",
        cfAccessClientSecretSealed: "sealed-secret",
      }),
    );
    const found = await store.getUserConnection(subject);
    expect(found?.locale).toBe("ru-RU");
    expect(found?.cfAccessClientIdSealed).toBe("sealed-id");
    expect(found?.cfAccessClientSecretSealed).toBe("sealed-secret");
  });

  it("overwrites a connection on the same subject instead of failing", async () => {
    await fresh();
    const subject = id("google");
    await store.putUserConnection(
      connection({ subject, cfAccessClientIdSealed: "sealed-id" }),
    );
    // Saving the page again is an update, not a duplicate key.
    await store.putUserConnection(
      connection({ subject, seerrUrl: "https://other.example.test", updatedAt: 42 }),
    );
    const found = await store.getUserConnection(subject);
    expect(found?.seerrUrl).toBe("https://other.example.test");
    expect(found?.updatedAt).toBe(42);
    // Clearing the Access pair must actually clear it.
    expect(found?.cfAccessClientIdSealed).toBeUndefined();
  });

  it("forgets a disconnected account", async () => {
    await fresh();
    const subject = id("google");
    await store.putUserConnection(connection({ subject }));
    await store.deleteUserConnection(subject);
    expect(await store.getUserConnection(subject)).toBeUndefined();
  });

  it("keeps two people apart", async () => {
    await fresh();
    const mine = id("google");
    const yours = id("google");
    await store.putUserConnection(connection({ subject: mine, seerrUrl: "https://mine.test" }));
    await store.putUserConnection(connection({ subject: yours, seerrUrl: "https://yours.test" }));
    expect((await store.getUserConnection(mine))?.seerrUrl).toBe("https://mine.test");
    expect((await store.getUserConnection(yours))?.seerrUrl).toBe("https://yours.test");
  });
});
