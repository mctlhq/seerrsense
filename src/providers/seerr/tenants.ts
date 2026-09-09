import type { AuthInfo } from "@modelcontextprotocol/server";
import { open } from "../../auth/crypto.js";
import type { AuthStore } from "../../auth/store.js";
import { SeerrClient } from "./client.js";

/**
 * Which Seerr a request talks to, and as whom.
 *
 * `client` is undefined when the person has attached nothing and there is no
 * household instance to fall back on; the tools then say so instead of failing
 * obscurely. `seerrUserId` is only meaningful on the household instance — on
 * somebody's own Seerr the API key is already theirs.
 */
export interface Tenant {
  client?: SeerrClient;
  email: string;
  attributedUserId?: number;
  source: "own" | "household" | "none";
  /** The OAuth subject this tenant was resolved for. Undefined for the legacy
   * shared token and stdio mode, where there is no subject to key on. This is
   * what the model resolve budget keys on. */
  subject?: string;
}

interface CacheEntry {
  tenant: Tenant;
  expiresAt: number;
}

/**
 * Resolves the caller to a Seerr.
 *
 * /mcp is served without touching the database today, and a lookup on every
 * tool call would change that, so resolutions are cached briefly per subject.
 * The window is short enough that attaching or detaching a Seerr takes effect
 * while the person is still looking at the page.
 */
export class TenantResolver {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly store: AuthStore | undefined,
    private readonly encryptionKey: Buffer | undefined,
    private readonly household: SeerrClient | undefined,
    private readonly householdEmails: Set<string> = new Set(),
    private readonly ttlMs = 60_000,
    /** Injectable for tests; forwarded to every per-user SeerrClient's guard. */
    private readonly lookup?: (host: string) => Promise<string[]>,
  ) {}

  async resolve(auth: AuthInfo | undefined): Promise<Tenant> {
    const subject = typeof auth?.extra?.subject === "string" ? auth.extra.subject : undefined;
    const email = typeof auth?.extra?.email === "string" ? auth.extra.email : "";

    // No identity at all: the legacy shared token and stdio mode. They get the
    // household instance, which is exactly what they had before, with no
    // address to check.
    const identity = this.identity(subject);
    if (!identity) {
      return this.householdTenant(email, subject);
    }

    const cached = this.cache.get(identity.subject);
    if (cached && cached.expiresAt > Date.now()) return cached.tenant;

    const connection = await identity.store.getUserConnection(identity.subject);
    let tenant: Tenant;
    if (connection) {
      tenant = {
        client: new SeerrClient({
          baseUrl: connection.seerrUrl,
          apiKey: open(connection.seerrApiKeySealed, identity.encryptionKey),
          locale: connection.locale,
          cfAccessClientId: connection.cfAccessClientIdSealed
            ? open(connection.cfAccessClientIdSealed, identity.encryptionKey)
            : undefined,
          cfAccessClientSecret: connection.cfAccessClientSecretSealed
            ? open(connection.cfAccessClientSecretSealed, identity.encryptionKey)
            : undefined,
          untrusted: true,
          lookup: this.lookup,
        }),
        email: connection.email || email,
        source: "own",
        subject: identity.subject,
      };
    } else {
      tenant = await this.householdTenant(email, identity.subject);
    }

    const replaced = this.cache.get(identity.subject);
    this.cache.set(identity.subject, { tenant, expiresAt: Date.now() + this.ttlMs });
    if (replaced && replaced.tenant !== tenant) void closeIfOwned(replaced.tenant);
    return tenant;
  }

  /** Called when a connection is written or removed, so the change is immediate. */
  forget(subject: string): void {
    const evicted = this.cache.get(subject);
    this.cache.delete(subject);
    // A per-user client owns an undici Agent with its own keep-alive pool;
    // dropping the reference without closing it leaks the sockets.
    void closeIfOwned(evicted?.tenant);
  }

  /**
   * The per-user path, or `undefined` when there is none: a caller needs an
   * identity of their own, a store to look a connection up in, and a key to
   * unseal it with. Missing any one of them means there is nothing to resolve
   * per person, so the caller reaches the household instance with no address
   * checked — the legacy shared token and stdio mode, and equally any
   * deployment running without SEERRSENSE_ENCRYPTION_KEY.
   *
   * Returns the narrowed trio rather than a boolean so `resolve` can use it
   * directly: a boolean would leave callers re-testing the same three fields
   * to satisfy the compiler, which is how the two answers drifted apart in
   * the first place.
   */
  private identity(
    subject: string | undefined,
  ): { subject: string; store: AuthStore; encryptionKey: Buffer } | undefined {
    if (!subject || subject === "static-token" || !this.store || !this.encryptionKey) {
      return undefined;
    }
    return { subject, store: this.store, encryptionKey: this.encryptionKey };
  }

  /**
   * What a caller with no connection of their own reaches. This is the
   * resolver's own decision, exposed so the account page can state the truth
   * instead of keeping a second copy of the rule that drifts from this one.
   * Synchronous, makes no network call, and never touches the per-subject
   * cache.
   *
   * `subject` matters: an unidentified caller is admitted without an address
   * check, so applying the allowlist to them here would promise something
   * stricter than what they actually get.
   */
  householdFallback(email: string, subject: string | undefined): "household" | "none" {
    if (!this.household) return "none";
    if (!this.identity(subject)) return "household";
    if (!this.householdEmails.has(email.toLowerCase())) return "none";
    return "household";
  }

  /**
   * Admission to the shared instance, decided by `householdFallback` and
   * nowhere else — a signed-in caller must be a named household owner, while
   * the legacy shared token, stdio mode and a keyless deployment have no
   * address to check and keep today's behaviour.
   */
  private async householdTenant(email: string, subject: string | undefined): Promise<Tenant> {
    if (this.householdFallback(email, subject) === "none") {
      return { email, source: "none", subject };
    }
    // Reaching here means a client exists: householdFallback returns "none"
    // whenever `this.household` is undefined. TypeScript cannot see that
    // invariant through the method call, hence the assertion below.
    const household = this.household!;
    // On the shared instance the API key belongs to the owner, so a request
    // would otherwise be filed under their name. Overseerr accepts a userId,
    // and the person's own address is what identifies them there.
    let attributedUserId: number | undefined;
    if (email) {
      try {
        attributedUserId = await household.findUserIdByEmail(email);
      } catch {
        // Attribution is a nicety; failing to look it up must not stop a search.
      }
    }
    return { client: household, email, attributedUserId, source: "household", subject };
  }
}

/** What the tools say when there is nothing to talk to. */
export function notConnectedMessage(publicUrl: string | undefined): string {
  const where = publicUrl ? `${publicUrl}/account` : "the account page";
  return `No Seerr is connected to this account yet. Open ${where} to attach your Overseerr or Jellyseerr.`;
}

/** Closes a tenant's own SeerrClient, never the shared household one. */
async function closeIfOwned(tenant: Tenant | undefined): Promise<void> {
  if (tenant?.source !== "own") return;
  await tenant.client?.close().catch(() => {});
}
