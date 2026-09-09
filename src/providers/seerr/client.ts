import { config } from "../../core/config.js";
import { 
  MediaCandidate, 
  MediaStatus, 
  SeerrSearchResponseSchema, 
  SeerrResultItemSchema, 
  MediaType 
} from "../../core/media.js";

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
}

export class SeerrClient {
  private baseUrl: string;
  private apiKey: string;
  private locale: string;
  private cfAccessClientId?: string;
  private cfAccessClientSecret?: string;

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
  }

  private async fetch(path: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "X-Api-Key": this.apiKey,
          "Accept-Language": this.locale,
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
          ...(this.cfAccessClientId ? { "CF-Access-Client-Id": this.cfAccessClientId } : {}),
          ...(this.cfAccessClientSecret ? { "CF-Access-Client-Secret": this.cfAccessClientSecret } : {}),
          ...(options.headers || {}),
        },
      });

      if (!response.ok) {
        throw new Error(`Seerr API error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
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

  async search(query: string): Promise<MediaCandidate[]> {
    const rawData = await this.fetch(`/api/v1/search?query=${encodeURIComponent(query)}`);
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
