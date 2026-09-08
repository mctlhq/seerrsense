import pg from "pg";
import type { AuthStore, AuthCode, PendingAuth, RefreshRecord } from "./store.js";

/** Arbitrary but fixed: the key two pods agree on while creating the schema. */
const SCHEMA_LOCK_ID = 8_787_004_2;

function safeSslMode(connectionString: string): string | null {
  try {
    return new URL(connectionString).searchParams.get("sslmode");
  } catch {
    return null;
  }
}

const SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS oauth_pending_auth (
        state           TEXT PRIMARY KEY,
        client_id       TEXT        NOT NULL,
        redirect_uri    TEXT        NOT NULL,
        client_state    TEXT,
        code_challenge  TEXT        NOT NULL,
        scope           TEXT        NOT NULL,
        resource        TEXT        NOT NULL,
        google_verifier TEXT        NOT NULL,
        google_nonce    TEXT        NOT NULL,
        expires_at      BIGINT      NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_auth_codes (
        code           TEXT PRIMARY KEY,
        client_id      TEXT   NOT NULL,
        redirect_uri   TEXT   NOT NULL,
        code_challenge TEXT   NOT NULL,
        scope          TEXT   NOT NULL,
        resource       TEXT   NOT NULL,
        subject        TEXT   NOT NULL,
        email          TEXT   NOT NULL,
        expires_at     BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash  TEXT PRIMARY KEY,
        family_id   TEXT   NOT NULL,
        client_id   TEXT   NOT NULL,
        scope       TEXT   NOT NULL,
        resource    TEXT   NOT NULL,
        subject     TEXT   NOT NULL,
        email       TEXT   NOT NULL,
        expires_at  BIGINT NOT NULL,
        consumed_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS oauth_refresh_family ON oauth_refresh_tokens (family_id);
    `;

/**
 * PostgreSQL-backed store, used when DATABASE_URL is set. It is what lets the
 * service keep refresh tokens across a rollout and run more than one replica:
 * every piece of OAuth state lives here rather than in the process.
 *
 * Schema is created on start rather than through a migration tool: three tables
 * with no history to preserve, and the service must come up on an empty
 * database without an extra deploy step.
 */
export class PostgresAuthStore implements AuthStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    // The platform injects DATABASE_URL without an sslmode parameter, and
    // node-postgres reads that as "no TLS" even though shared-pg serves it.
    // Default to TLS and let sslmode=disable opt out for a local database.
    // Verification is off because the cluster has no CA distribution yet — the
    // same compromise mctl-academy documents in server/db-ssl.mjs.
    const sslmode = safeSslMode(connectionString);
    // Per-role connection limit on shared-pg is 10, and a rollout briefly runs
    // two pods, so a small pool keeps both inside the limit.
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
      ssl: sslmode === "disable" ? undefined : { rejectUnauthorized: false },
    });
  }

  async init(): Promise<void> {
    // A rollout surges a second pod before the old one exits, so two processes
    // can run this at once; concurrent CREATE TABLE IF NOT EXISTS races on the
    // system catalogue. An advisory lock serialises them, as mctl-academy and
    // pfeifenpatenschaft-backend both do for their migrations.
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK_ID]);
      await client.query(SCHEMA_SQL);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK_ID]).catch(() => {});
      client.release();
    }
  }


  async putPendingAuth(p: PendingAuth): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_pending_auth
         (state, client_id, redirect_uri, client_state, code_challenge, scope, resource,
          google_verifier, google_nonce, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.state, p.clientId, p.redirectUri, p.clientState ?? null, p.codeChallenge, p.scope,
       p.resource, p.googleVerifier, p.googleNonce, p.expiresAt],
    );
  }

  /** DELETE ... RETURNING makes the read and the consume one atomic step. */
  async takePendingAuth(state: string): Promise<PendingAuth | undefined> {
    const { rows } = await this.pool.query(
      `DELETE FROM oauth_pending_auth WHERE state = $1 RETURNING *`, [state]);
    const row = rows[0];
    if (!row || Number(row.expires_at) < Date.now()) return undefined;
    return {
      state: row.state,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      clientState: row.client_state ?? undefined,
      codeChallenge: row.code_challenge,
      scope: row.scope,
      resource: row.resource,
      googleVerifier: row.google_verifier,
      googleNonce: row.google_nonce,
      expiresAt: Number(row.expires_at),
    };
  }

  async putAuthCode(c: AuthCode): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_auth_codes
         (code, client_id, redirect_uri, code_challenge, scope, resource, subject, email, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [c.code, c.clientId, c.redirectUri, c.codeChallenge, c.scope, c.resource, c.subject,
       c.email, c.expiresAt],
    );
  }

  async takeAuthCode(code: string): Promise<AuthCode | undefined> {
    const { rows } = await this.pool.query(
      `DELETE FROM oauth_auth_codes WHERE code = $1 RETURNING *`, [code]);
    const row = rows[0];
    if (!row || Number(row.expires_at) < Date.now()) return undefined;
    return {
      code: row.code,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      scope: row.scope,
      resource: row.resource,
      subject: row.subject,
      email: row.email,
      expiresAt: Number(row.expires_at),
    };
  }

  async putRefreshToken(r: RefreshRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_refresh_tokens
         (token_hash, family_id, client_id, scope, resource, subject, email, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.tokenHash, r.familyId, r.clientId, r.scope, r.resource, r.subject, r.email, r.expiresAt],
    );
  }

  async getRefreshToken(tokenHash: string): Promise<RefreshRecord | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM oauth_refresh_tokens WHERE token_hash = $1`, [tokenHash]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      tokenHash: row.token_hash,
      familyId: row.family_id,
      clientId: row.client_id,
      scope: row.scope,
      resource: row.resource,
      subject: row.subject,
      email: row.email,
      expiresAt: Number(row.expires_at),
      consumedAt: row.consumed_at === null ? undefined : Number(row.consumed_at),
    };
  }

  async markRefreshConsumed(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE oauth_refresh_tokens SET consumed_at = $2 WHERE token_hash = $1`,
      [tokenHash, Date.now()]);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.pool.query(`DELETE FROM oauth_refresh_tokens WHERE family_id = $1`, [familyId]);
  }

  async revokeToken(tokenHash: string): Promise<void> {
    await this.pool.query(`DELETE FROM oauth_refresh_tokens WHERE token_hash = $1`, [tokenHash]);
  }

  async purgeExpired(now = Date.now()): Promise<void> {
    await this.pool.query(`DELETE FROM oauth_pending_auth WHERE expires_at < $1`, [now]);
    await this.pool.query(`DELETE FROM oauth_auth_codes WHERE expires_at < $1`, [now]);
    await this.pool.query(`DELETE FROM oauth_refresh_tokens WHERE expires_at < $1`, [now]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
