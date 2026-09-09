import { Agent } from "undici";
import { config } from "../../core/config.js";
import { assertPublicSeerrUrl, isBlockedAddress } from "./guard.js";
import {
  MediaCandidate,
  MediaStatus,
  SeerrSearchResponseSchema,
  SeerrResultItemSchema,
  MediaType
} from "../../core/media.js";

/** Ceiling on an untrusted Seerr's response body. Overseerr's own payloads are
 * far below this; the number exists so a hostile host cannot stream forever. */
const MAX_UNTRUSTED_BODY_BYTES = 5 * 1024 * 1024;

/** How long a client trusts its own guard check before re-running it. */
const GUARD_MEMO_MS = 5_000;

/**
 * Raised for any failure dialling an untrusted (per-user) Seerr: transport
 * failure, timeout, a refused 3xx, or a non-2xx response. Carries the
 * upstream status only internally, for logging — never in the message a
 * caller can see, since every MCP tool relays `error.message` verbatim.
 */
export class SeerrUnreachableError extends Error {
  constructor(
    message = "could not reach that Seerr",
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "SeerrUnreachableError";
  }
}

/** Raised when a dial to an untrusted Seerr is answered by Cloudflare Access. */
export class SeerrAccessChallengeError extends Error {
  constructor(message = "that address is behind Cloudflare Access") {
    super(message);
    this.name = "SeerrAccessChallengeError";
  }
}

function isCloudflareAccessChallenge(response: Response, location: string | null): boolean {
  if (location) {
    try {
      if (new URL(location, response.url || undefined).hostname.endsWith(".cloudflareaccess.com")) return true;
    } catch {
      // Not a parseable absolute-or-relative URL; fall through to the header check.
    }
  }
  if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") return true;
  for (const key of response.headers.keys()) {
    if (key.toLowerCase().startsWith("cf-access-")) return true;
  }
  return false;
}

/** A `dns.lookup`-shaped callback that only ever answers with a guard-approved
 * address, re-checked here so a second DNS answer between check and connect
 * cannot reach a different host. */
export function pinnedLookup(addresses: string[]) {
  return (
    _hostname: string,
    options: { all?: boolean } | ((err: Error | null, address?: unknown, family?: number) => void),
    callback?: (err: Error | null, address?: unknown, family?: number) => void,
  ) => {
    const cb = typeof options === "function" ? options : callback!;
    const wantsAll = typeof options === "object" && options?.all === true;
    const safe = addresses.filter((address) => !isBlockedAddress(address));
    if (safe.length === 0) {
      cb(new Error("no safe address available for this host"));
      return;
    }
    if (wantsAll) {
      cb(
        null,
        safe.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      );
      return;
    }
    const address = safe[0];
    cb(null, address, address.includes(":") ? 6 : 4);
  };
}

/**
 * Credentials for one Seerr. Cloudflare Access is per-instance rather than
 * global: one person's Seerr may sit behind Zero Trust and another's may not.
 */
export interface SeerrCredentials {
  baseUrl: string;
  apiKey: string;
  locale?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  /**
   * Set for any client built from a user-supplied address: the `PUT`
   * candidate and every per-user connection. The operator-configured
   * household client never sets this, and is exempt from the address guard
   * and from DNS pinning.
   */
  untrusted?: boolean;
  /** Injectable for tests; defaults to a real DNS lookup inside the guard. */
  lookup?: (host: string) => Promise<string[]>;
}

export class SeerrClient {
  private baseUrl: string;
  private apiKey: string;
  private locale: string;
  private cfAccessClientId?: string;
  private cfAccessClientSecret?: string;
  private untrusted: boolean;
  private lookup?: (host: string) => Promise<string[]>;
  private guardCache?: { expiresAt: number; addresses: string[]; dispatcher: Agent };

  constructor(credentials: SeerrCredentials);
  constructor(baseUrl: string, apiKey: string, locale?: string);
  constructor(first: SeerrCredentials | string, apiKey?: string, locale?: string) {
    const credentials: SeerrCredentials =
      typeof first === "string" ? { baseUrl: first, apiKey: apiKey ?? "", locale } : first;
    this.baseUrl = credentials.baseUrl.replace(/\/$/, "");
    this.apiKey = credentials.apiKey;
    this.locale = credentials.locale ?? "en-US";
    this.cfAccessClientId = credentials.cfAccessClientId;
    this.cfAccessClientSecret = credentials.cfAccessClientSecret;
    this.untrusted = credentials.untrusted ?? false;
    this.lookup = credentials.lookup;
  }

  private async guardedDispatcher(): Promise<Agent> {
    const cached = this.guardCache;
    if (cached && cached.expiresAt > Date.now()) return cached.dispatcher;

    // Throws BlockedAddressError, which propagates as a generic, caller-safe
    // message: this is the dial-time re-check that catches a hostname whose
    // meaning changed since the connection was stored.
    const { addresses } = await assertPublicSeerrUrl(this.baseUrl, { lookup: this.lookup });
    const previous = cached?.dispatcher;
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses) as never } });
    this.guardCache = { expiresAt: Date.now() + GUARD_MEMO_MS, addresses, dispatcher };
    if (previous) previous.close().catch(() => {});
    return dispatcher;
  }

  private async fetch(path: string, options: RequestInit = {}) {
    if (this.untrusted) return this.fetchUntrusted(path, options);
    return this.fetchTrusted(path, options);
  }

  private headersFor(extra?: HeadersInit): Record<string, string> {
    return {
      "X-Api-Key": this.apiKey,
      "Accept-Language": this.locale,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      ...(this.cfAccessClientId ? { "CF-Access-Client-Id": this.cfAccessClientId } : {}),
      ...(this.cfAccessClientSecret ? { "CF-Access-Client-Secret": this.cfAccessClientSecret } : {}),
      ...((extra as Record<string, string>) || {}),
    };
  }

  /** Today's behaviour, unchanged: the operator's own household instance. */
  private async fetchTrusted(path: string, options: RequestInit) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: this.headersFor(options.headers),
      });

      if (!response.ok) {
        throw new Error(`Seerr API error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * A user-supplied address: guarded and DNS-pinned before every request, no
   * redirect ever followed, and every failure reduced to a typed error that
   * carries no upstream detail a caller could see.
   */
  private async fetchUntrusted(path: string, options: RequestInit) {
    const dispatcher = await this.guardedDispatcher();
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        redirect: "manual",
        // @ts-expect-error -- `dispatcher` is undici's extension to fetch's
        // options, not part of the standard RequestInit type.
        dispatcher,
        headers: this.headersFor(options.headers),
      });
    } catch (error) {
      clearTimeout(timeoutId);
      throw new SeerrUnreachableError("could not reach that Seerr");
    }

    // The timer stays armed until the body has been read. Clearing it here —
    // before response.json() — would let a host that trickles or never
    // finishes its body park this handler, its socket and its undici
    // connection for as long as it likes, and by construction of
    // `untrusted: true` that host was chosen by the person, not by us.
    try {
      return await this.readUntrusted(response);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Body handling for an untrusted response: no redirect followed, no
   * upstream detail relayed, and a ceiling on how much will be read. */
  private async readUntrusted(response: Response) {
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (isCloudflareAccessChallenge(response, location)) {
        throw new SeerrAccessChallengeError();
      }
      // Never followed: a redirect could point at a second, unvetted host.
      throw new SeerrUnreachableError("could not reach that Seerr", response.status);
    }
    if (isCloudflareAccessChallenge(response, null)) {
      throw new SeerrAccessChallengeError();
    }
    if (!response.ok) {
      throw new SeerrUnreachableError("could not reach that Seerr", response.status);
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_UNTRUSTED_BODY_BYTES) {
      throw new SeerrUnreachableError("could not reach that Seerr", response.status);
    }
    // Counted while reading, not after: content-length is absent under chunked
    // encoding — which the untrusted host chooses — so a check after
    // response.text() would cap what is returned, having already buffered
    // whatever was sent. The reader is cancelled the moment the ceiling is
    // crossed, so nothing beyond it is ever held.
    const text = await this.readCapped(response);
    try {
      return JSON.parse(text);
    } catch {
      throw new SeerrUnreachableError("could not reach that Seerr", response.status);
    }
  }

  private async readCapped(response: Response): Promise<string> {
    const body = response.body;
    // A stubbed fetch may hand back a response with no stream; there is
    // nothing to meter in that case and text() is the whole of it.
    if (!body) return await response.text();

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let read = 0;
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
        if (read > MAX_UNTRUSTED_BODY_BYTES) {
          throw new SeerrUnreachableError("could not reach that Seerr", response.status);
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return text + decoder.decode();
  }

  /**
   * Releases the pinned dispatcher and its keep-alive sockets. Per-user
   * clients are short-lived by design — TenantResolver rebuilds one about
   * once a minute for a steadily-used account — so whoever discards a client
   * must call this or the agents accumulate, each holding open connections.
   */
  async close(): Promise<void> {
    const cached = this.guardCache;
    this.guardCache = undefined;
    if (cached) await cached.dispatcher.close().catch(() => {});
  }

  async status(): Promise<any> {
    return this.fetch(`/api/v1/status`);
  }

  private mapStatus(status?: number): MediaStatus {
    switch (status) {
      case 2: return "PENDING";
      case 3: return "PROCESSING";
      case 4: return "PARTIALLY_AVAILABLE";
      case 5: return "AVAILABLE";
      case 6: return "BLOCKLISTED";
      case 7: return "DELETED";
      default: return "UNKNOWN"; // 1 or others
    }
  }

  private extractYear(dateStr?: string): number | undefined {
    if (!dateStr) return undefined;
    const year = parseInt(dateStr.split("-")[0]);
    return isNaN(year) ? undefined : year;
  }

  /**
   * Overseerr answers 400 Bad Request to any search term containing
   * parentheses — measured against the live instance, where "The Matrix (1999)"
   * fails and "The Matrix" returns twenty results, at any length. A year in
   * parentheses is the most natural way both a person and a language model
   * write a title, so the term is stripped of parenthesised spans rather than
   * allowed to become a hard error. Nothing is lost: Overseerr would not have
   * matched a title on that annotation anyway.
   */
  static searchTerm(query: string): string {
    return query.replace(/\([^)]*\)?/g, " ").replace(/\s+/g, " ").trim();
  }

  async search(query: string): Promise<MediaCandidate[]> {
    const term = SeerrClient.searchTerm(query);
    if (term === "") return [];
    const rawData = await this.fetch(`/api/v1/search?query=${encodeURIComponent(term)}`);
    const data = SeerrSearchResponseSchema.parse(rawData);
    const results: MediaCandidate[] = [];

    for (const item of (data.results || [])) {
      if (item.mediaType !== "movie" && item.mediaType !== "tv") continue;
      
      const mediaInfo = item.mediaInfo || {};
      
      results.push({
        provider: "tmdb",
        providerId: item.id,
        mediaType: item.mediaType as MediaType,
        title: (item.title || item.name) ?? "Unknown",
        originalTitle: item.originalTitle || item.originalName,
        year: this.extractYear(item.releaseDate || item.firstAirDate),
        posterUrl: item.posterPath,
        overview: item.overview,
        status: this.mapStatus(mediaInfo.status)
      });
    }

    return results;
  }

  async getMedia(mediaType: MediaType, tmdbId: number): Promise<MediaCandidate> {
    const rawData = await this.fetch(`/api/v1/${mediaType}/${tmdbId}`);
    const item = SeerrResultItemSchema.parse(rawData);
    const mediaInfo = item.mediaInfo || {};

    return {
      provider: "tmdb",
      providerId: item.id,
      mediaType: mediaType,
      title: (item.title || item.name) ?? "Unknown",
      originalTitle: item.originalTitle || item.originalName,
      year: this.extractYear(item.releaseDate || item.firstAirDate),
      posterUrl: item.posterPath,
      overview: item.overview,
      status: this.mapStatus(mediaInfo.status)
    };
  }

  /**
   * Confirms the address and key work, and names who the key belongs to.
   * Used before a connection is stored so a bad key fails in front of the
   * person entering it rather than later inside an assistant.
   */
  async describeSelf(): Promise<string | undefined> {
    const data = await this.fetch(`/api/v1/auth/me`);
    const me = data as { displayName?: string; email?: string; username?: string };
    return me.displayName || me.username || me.email;
  }

  /** Seerr's own user list, used to file a request as the person who asked. */
  async findUserIdByEmail(email: string): Promise<number | undefined> {
    if (!email) return undefined;
    const data = await this.fetch(`/api/v1/user?take=200`);
    const results = (data as { results?: Array<{ id?: number; email?: string }> }).results ?? [];
    const wanted = email.toLowerCase();
    return results.find((user) => (user.email ?? "").toLowerCase() === wanted)?.id;
  }

  async requestMedia(
    mediaType: MediaType,
    tmdbId: number,
    seasons?: number[],
    userId?: number,
  ): Promise<any> {
    const payload: any = {
      mediaType,
      mediaId: tmdbId
    };

    if (mediaType === "tv") {
      payload.seasons = seasons && seasons.length > 0 ? seasons : "all";
    }

    // Overseerr accepts userId on a request made with an admin key, so a shared
    // household instance still shows who actually asked, and that person's
    // quota and approval rules apply instead of the key owner's.
    if (userId !== undefined) {
      payload.userId = userId;
    }

    return this.fetch(`/api/v1/request`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }
}

/**
 * The household instance from the environment, when one is configured.
 *
 * It is no longer the only Seerr this server talks to — a signed-in person can
 * attach their own — but it stays the default for the legacy shared token, for
 * stdio mode, and for anyone who has not attached one.
 */
export function createDefaultSeerrClient(): SeerrClient | undefined {
  if (!config.SEERR_API_KEY) return undefined;
  return new SeerrClient({
    baseUrl: config.SEERR_URL,
    apiKey: config.SEERR_API_KEY,
    locale: config.SEERRSENSE_LOCALE,
    cfAccessClientId: config.CF_ACCESS_CLIENT_ID,
    cfAccessClientSecret: config.CF_ACCESS_CLIENT_SECRET,
  });
}

// Kept as a module-level export: it is the household client, and every caller
// that has no per-user context still reaches for it.
export const seerrClient =
  createDefaultSeerrClient() ?? new SeerrClient({ baseUrl: config.SEERR_URL, apiKey: "" });
