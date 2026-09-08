import { MediaType } from "../core/media.js";
import type { SeerrClient } from "../providers/seerr/client.js";

export type SeerrRequestPayload = {
  mediaType: MediaType;
  tmdbId: number;
  seasons?: number[];
};

export class MediaRequestService {
  /**
   * The Seerr to act on, and the user id to file under. Both come from the
   * caller now: which Seerr this is depends on who asked.
   */
  constructor(
    private readonly seerrClient: SeerrClient,
    private readonly attributedUserId?: number,
  ) {}

  async requestMediaSafely(payload: SeerrRequestPayload) {
    // 1. Canonical provider validation
    const canonicalMedia = await this.seerrClient.getMedia(payload.mediaType, payload.tmdbId);
    
    // 2. Check current state
    if (canonicalMedia.status !== "UNKNOWN" && canonicalMedia.status !== "PARTIALLY_AVAILABLE" && canonicalMedia.status !== "DELETED") {
      throw new Error(`Media is already in status: ${canonicalMedia.status}`);
    }

    // 3. Mutate
    return await this.seerrClient.requestMedia(
      payload.mediaType,
      payload.tmdbId,
      payload.seasons,
      this.attributedUserId,
    );
  }
}
