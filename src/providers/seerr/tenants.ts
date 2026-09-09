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
    if (!subject || subject === "static-token" || !this.store || !this.encryptionKey) {
      return this.householdTenant(email, subject, false);
    }

    const cached = this.cache.get(subject);
    if (cached && cached.expiresAt > Date.now()) return cached.tenant;

    const connection = await this.store.getUserConnection(subject);
    let tenant: Tenant;
    if (connection) {
      tenant = {
        client: new SeerrClient({
          baseUrl: connection.seerrUrl,
          apiKey: open(connection.seerrApiKeySealed, this.encryptionKey),
          locale: connection.locale,
          cfAccessClientId: connection.cfAccessClientIdSealed
            ? open(connection.cfAccessClientIdSealed, this.encryptionKey)
            : undefined,
          cfAccessClientSecret: connection.cfAccessClientSecretSealed
            ? open(connection.cfAccessClientSecretSealed, this.encryptionKey)
            : undefined,
          untrusted: true,
          lookup: this.lookup,
        }),
        email: connection.email || email,
        source: "own",
        subject,
      };
    } else {
      tenant = await this.householdTenant(email, subject, true);
    }

    this.cache.set(subject, { tenant, expiresAt: Date.now() + this.ttlMs });
    return tenant;
  }

  /** Called when a connection is written or removed, so the change is immediate. */
  forget(subject: string): void {
    this.cache.delete(subject);
  }

  /**
   * `ownerOnly` is true on the signed-in path, where a caller with no
   * user_connections row of their own must be a named household owner to
   * reach the shared instance. It is false for the legacy shared token and
   * stdio mode, which have no address to check and keep today's behaviour.
   */
  private async householdTenant(
    email: string,
    subject: string | undefined,
    ownerOnly: boolean,
  ): Promise<Tenant> {
    if (!this.household) return { email, source: "none", subject };
    if (ownerOnly && !this.householdEmails.has(email.toLowerCase())) {
      return { email, source: "none", subject };
    }
    // On the shared instance the API key belongs to the owner, so a request
    // would otherwise be filed under their name. Overseerr accepts a userId,
    // and the person's own address is what identifies them there.
    let attributedUserId: number | undefined;
    if (email) {
      try {
        attributedUserId = await this.household.findUserIdByEmail(email);
      } catch {
        // Attribution is a nicety; failing to look it up must not stop a search.
      }
    }
    return { client: this.household, email, attributedUserId, source: "household", subject };
  }
}

/** What the tools say when there is nothing to talk to. */
export function notConnectedMessage(publicUrl: string | undefined): string {
  const where = publicUrl ? `${publicUrl}/account` : "the account page";
  return `No Seerr is connected to this account yet. Open ${where} to attach your Overseerr or Jellyseerr.`;
}
