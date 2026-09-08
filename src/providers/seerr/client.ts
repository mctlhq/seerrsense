import { config } from "../../core/config.js";
import { 
  MediaCandidate, 
  MediaStatus, 
  SeerrSearchResponseSchema, 
  SeerrResultItemSchema, 
  MediaType 
} from "../../core/media.js";

export class SeerrClient {
  private baseUrl: string;
  private apiKey: string;
  private locale: string;

  constructor(baseUrl: string, apiKey: string, locale: string = "en-US") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.locale = locale;
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
          ...(config.CF_ACCESS_CLIENT_ID ? { "CF-Access-Client-Id": config.CF_ACCESS_CLIENT_ID } : {}),
          ...(config.CF_ACCESS_CLIENT_SECRET ? { "CF-Access-Client-Secret": config.CF_ACCESS_CLIENT_SECRET } : {}),
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

  async requestMedia(mediaType: MediaType, tmdbId: number, seasons?: number[]): Promise<any> {
    const payload: any = {
      mediaType,
      mediaId: tmdbId
    };

    if (mediaType === "tv") {
      payload.seasons = seasons && seasons.length > 0 ? seasons : "all";
    }

    return this.fetch(`/api/v1/request`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }
}

// Export singleton instance based on config
export const seerrClient = new SeerrClient(config.SEERR_URL, config.SEERR_API_KEY, config.SEERRSENSE_LOCALE);
