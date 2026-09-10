import { hashToken } from "./crypto.js";

/**
 * A login in flight. Created at /oauth/authorize and consumed at the Google
 * callback; then created a second time, now carrying the verified identity, to
 * survive the consent screen until the person answers it.
 */
export interface PendingAuth {
  state: string;
  clientId: string;
  redirectUri: string;
  clientState?: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  googleVerifier: string;
  googleNonce: string;
  expiresAt: number;
  /** Set only on the second hop, once Google has said who this is. */
  subject?: string;
  email?: string;
}

/** An authorization code: issued after Google verifies the user, consumed at /oauth/token. */
export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  /** The client's own state, echoed back untouched on the final redirect. */
  clientState?: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  subject: string;
  email: string;
  expiresAt: number;
}

/**
 * A refresh token, stored hashed. `familyId` ties every rotation of one login
 * together so presenting a token that was already rotated can revoke the whole
 * family rather than just that one token.
 */
export interface RefreshRecord {
  tokenHash: string;
  familyId: string;
  clientId: string;
  scope: string;
  resource: string;
  subject: string;
  email: string;
  expiresAt: number;
  consumedAt?: number;
}

/**
 * A person's own Seerr, keyed by the OAuth subject. The API key is stored
 * sealed; nothing else here is secret.
 *
 * This is the one table whose contents cannot be recreated by asking the user
 * to sign in again, so unlike the OAuth state it is never swept by purgeExpired.
 */
export interface UserConnection {
  subject: string;
  email: string;
  seerrUrl: string;
  seerrApiKeySealed: string;
  locale?: string;
  cfAccessClientIdSealed?: string;
  cfAccessClientSecretSealed?: string;
  updatedAt: number;
}

export interface AuthStore {
  init(): Promise<void>;
  putPendingAuth(pending: PendingAuth): Promise<void>;
  /** Single-use: returns the record and deletes it, so a replayed state fails. */
  takePendingAuth(state: string): Promise<PendingAuth | undefined>;
  putAuthCode(code: AuthCode): Promise<void>;
  /** Single-use, per RFC 6749 §4.1.2. */
  takeAuthCode(code: string): Promise<AuthCode | undefined>;
  putRefreshToken(record: RefreshRecord): Promise<void>;
  getRefreshToken(tokenHash: string): Promise<RefreshRecord | undefined>;
  markRefreshConsumed(tokenHash: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
  revokeToken(tokenHash: string): Promise<void>;
  purgeExpired(now?: number): Promise<void>;
  getUserConnection(subject: string): Promise<UserConnection | undefined>;
  putUserConnection(connection: UserConnection): Promise<void>;
  deleteUserConnection(subject: string): Promise<void>;
  /**
   * Everything held about one person, gone in one call: the attached Seerr,
   * every refresh token (so every assistant is signed out), any login in
   * flight, and the resolve counters. Browser sessions are stateless and are
   * ended by the caller. This is what "Delete my account" means; the privacy
   * page promises it without a support e-mail.
   */
  deleteSubject(subject: string): Promise<void>;
  /**
   * Records a browser session as ended, keyed by its `jti`. `expiresAt` is the
   * session's own expiry (epoch milliseconds) — the record need not outlive
   * the cookie it revokes, so `purgeExpired` sweeps it on the same schedule as
   * everything else here.
   */
  revokeSession(id: string, expiresAt: number): Promise<void>;
  isSessionRevoked(id: string): Promise<boolean>;
  /**
   * Increments and returns the number of model-backed resolve calls a
   * subject (or the reserved `"__global__"` subject) has made on a given UTC
   * day (`YYYY-MM-DD`). Atomic, so two replicas cannot both see "one below
   * the cap".
   */
  countResolve(subject: string, day: string): Promise<number>;
  /** Drops resolve-usage rows for days before `before` (`YYYY-MM-DD`). */
  purgeResolveUsage(before: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * In-memory store. Correct for a single replica and for self-hosters, and the
 * only store a `npx seerrsense` user needs. It loses refresh tokens on restart,
 * which costs a re-login rather than access: authorization codes and pending
 * logins live ten minutes anyway.
 */
export class MemoryAuthStore implements AuthStore {
  private pending = new Map<string, PendingAuth>();
  private codes = new Map<string, AuthCode>();
  private refresh = new Map<string, RefreshRecord>();
  private connections = new Map<string, UserConnection>();
  /** Keyed on `${subject} ${day}`; the day never contains a space, so
   * lastIndexOf(" ") splits it back unambiguously. */
  private resolveUsage = new Map<string, number>();
  /** jti -> expiresAt (epoch ms). Lost on restart, exactly like refresh
   * tokens: a self-hoster on this store re-verifies stateless sessions rather
   * than keeping a revocation list across a restart. */
  private revokedSessions = new Map<string, number>();

  async init(): Promise<void> {}

  async putPendingAuth(pending: PendingAuth): Promise<void> {
    this.pending.set(pending.state, pending);
  }

  async takePendingAuth(state: string): Promise<PendingAuth | undefined> {
    const found = this.pending.get(state);
    this.pending.delete(state);
    if (!found || found.expiresAt < Date.now()) return undefined;
    return found;
  }

  async putAuthCode(code: AuthCode): Promise<void> {
    this.codes.set(code.code, code);
  }

  async takeAuthCode(code: string): Promise<AuthCode | undefined> {
    const found = this.codes.get(code);
    this.codes.delete(code);
    if (!found || found.expiresAt < Date.now()) return undefined;
    return found;
  }

  async putRefreshToken(record: RefreshRecord): Promise<void> {
    this.refresh.set(record.tokenHash, record);
  }

  async getRefreshToken(tokenHash: string): Promise<RefreshRecord | undefined> {
    return this.refresh.get(tokenHash);
  }

  async markRefreshConsumed(tokenHash: string): Promise<void> {
    const found = this.refresh.get(tokenHash);
    if (found) found.consumedAt = Date.now();
  }

  async revokeFamily(familyId: string): Promise<void> {
    for (const [hash, record] of this.refresh) {
      if (record.familyId === familyId) this.refresh.delete(hash);
    }
  }

  async revokeToken(tokenHash: string): Promise<void> {
    this.refresh.delete(tokenHash);
  }

  async purgeExpired(now = Date.now()): Promise<void> {
    for (const [key, value] of this.pending) if (value.expiresAt < now) this.pending.delete(key);
    for (const [key, value] of this.codes) if (value.expiresAt < now) this.codes.delete(key);
    for (const [key, value] of this.refresh) if (value.expiresAt < now) this.refresh.delete(key);
    for (const [key, expiresAt] of this.revokedSessions) {
      if (expiresAt < now) this.revokedSessions.delete(key);
    }
    // Connections are deliberately untouched: they do not expire, and losing one
    // means a person's Seerr silently detaches.
  }

  async getUserConnection(subject: string): Promise<UserConnection | undefined> {
    return this.connections.get(subject);
  }

  async putUserConnection(connection: UserConnection): Promise<void> {
    this.connections.set(connection.subject, connection);
  }

  async deleteUserConnection(subject: string): Promise<void> {
    this.connections.delete(subject);
  }

  async deleteSubject(subject: string): Promise<void> {
    this.connections.delete(subject);
    for (const [key, value] of this.pending) if (value.subject === subject) this.pending.delete(key);
    for (const [key, value] of this.codes) if (value.subject === subject) this.codes.delete(key);
    for (const [key, value] of this.refresh) if (value.subject === subject) this.refresh.delete(key);
    for (const key of this.resolveUsage.keys()) {
      if (key.slice(0, key.lastIndexOf(" ")) === subject) this.resolveUsage.delete(key);
    }
  }

  async revokeSession(id: string, expiresAt: number): Promise<void> {
    this.revokedSessions.set(id, expiresAt);
  }

  async isSessionRevoked(id: string): Promise<boolean> {
    return this.revokedSessions.has(id);
  }

  async countResolve(subject: string, day: string): Promise<number> {
    const key = `${subject} ${day}`;
    const next = (this.resolveUsage.get(key) ?? 0) + 1;
    this.resolveUsage.set(key, next);
    return next;
  }

  async purgeResolveUsage(before: string): Promise<void> {
    for (const key of this.resolveUsage.keys()) {
      const day = key.slice(key.lastIndexOf(" ") + 1);
      if (day < before) this.resolveUsage.delete(key);
    }
  }

  async close(): Promise<void> {
    this.pending.clear();
    this.codes.clear();
    this.refresh.clear();
    this.connections.clear();
    this.resolveUsage.clear();
    this.revokedSessions.clear();
  }
}

export { hashToken };
