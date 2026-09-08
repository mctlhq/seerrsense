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

  async close(): Promise<void> {
    this.pending.clear();
    this.codes.clear();
    this.refresh.clear();
    this.connections.clear();
  }
}

export { hashToken };
