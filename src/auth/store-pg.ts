import pg from "pg";
import type { AuthStore, AuthCode, PendingAuth, RefreshRecord, UserConnection } from "./store.js";

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
        expires_at      BIGINT      NOT NULL,
        subject         TEXT,
        email           TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth_auth_codes (
        code           TEXT PRIMARY KEY,
        client_id      TEXT   NOT NULL,
        redirect_uri   TEXT   NOT NULL,
        client_state   TEXT,
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
      CREATE TABLE IF NOT EXISTS user_connections (
        subject                   TEXT PRIMARY KEY,
        email                     TEXT   NOT NULL,
        seerr_url                 TEXT   NOT NULL,
        seerr_api_key_sealed      TEXT   NOT NULL,
        locale                    TEXT,
        cf_access_id_sealed       TEXT,
        cf_access_secret_sealed   TEXT,
        updated_at                BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resolve_usage (
        subject TEXT   NOT NULL,
        day     DATE   NOT NULL,
        count   INT    NOT NULL DEFAULT 0,
        PRIMARY KEY (subject, day)
      );
    `;

/**
 * Note on the schema: CREATE TABLE IF NOT EXISTS never alters a table that
 * already exists. These columns are safe to add now because no deployment has
 * created these tables yet; a later column needs a real migration.
 *
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
          google_verifier, google_nonce, expires_at, subject, email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [p.state, p.clientId, p.redirectUri, p.clientState ?? null, p.codeChallenge, p.scope,
       p.resource, p.googleVerifier, p.googleNonce, p.expiresAt, p.subject ?? null,
       p.email ?? null],
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
      subject: row.subject ?? undefined,
      email: row.email ?? undefined,
    };
  }

  async putAuthCode(c: AuthCode): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_auth_codes
         (code, client_id, redirect_uri, client_state, code_challenge, scope, resource,
          subject, email, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [c.code, c.clientId, c.redirectUri, c.clientState ?? null, c.codeChallenge, c.scope,
       c.resource, c.subject, c.email, c.expiresAt],
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
      clientState: row.client_state ?? undefined,
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
    // user_connections is not swept here on purpose — see the note on the type.
  }

  async getUserConnection(subject: string): Promise<UserConnection | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM user_connections WHERE subject = $1`, [subject]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      subject: row.subject,
      email: row.email,
      seerrUrl: row.seerr_url,
      seerrApiKeySealed: row.seerr_api_key_sealed,
      locale: row.locale ?? undefined,
      cfAccessClientIdSealed: row.cf_access_id_sealed ?? undefined,
      cfAccessClientSecretSealed: row.cf_access_secret_sealed ?? undefined,
      updatedAt: Number(row.updated_at),
    };
  }

  async putUserConnection(c: UserConnection): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_connections
         (subject, email, seerr_url, seerr_api_key_sealed, locale, cf_access_id_sealed,
          cf_access_secret_sealed, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (subject) DO UPDATE SET
         email = EXCLUDED.email,
         seerr_url = EXCLUDED.seerr_url,
         seerr_api_key_sealed = EXCLUDED.seerr_api_key_sealed,
         locale = EXCLUDED.locale,
         cf_access_id_sealed = EXCLUDED.cf_access_id_sealed,
         cf_access_secret_sealed = EXCLUDED.cf_access_secret_sealed,
         updated_at = EXCLUDED.updated_at`,
      [c.subject, c.email, c.seerrUrl, c.seerrApiKeySealed, c.locale ?? null,
       c.cfAccessClientIdSealed ?? null, c.cfAccessClientSecretSealed ?? null, c.updatedAt],
    );
  }

  async deleteUserConnection(subject: string): Promise<void> {
    await this.pool.query(`DELETE FROM user_connections WHERE subject = $1`, [subject]);
  }

  async countResolve(subject: string, day: string): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO resolve_usage (subject, day, count) VALUES ($1, $2::date, 1)
       ON CONFLICT (subject, day) DO UPDATE SET count = resolve_usage.count + 1
       RETURNING count`,
      [subject, day],
    );
    return Number(rows[0].count);
  }

  async purgeResolveUsage(before: string): Promise<void> {
    await this.pool.query(`DELETE FROM resolve_usage WHERE day < $1::date`, [before]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
