import { MediaType } from "../core/media.js";
import { seerrClient } from "../providers/seerr/client.js";

export type SeerrRequestPayload = {
  mediaType: MediaType;
  tmdbId: number;
  seasons?: number[];
};

export class MediaRequestService {
  async requestMediaSafely(payload: SeerrRequestPayload) {
    // 1. Canonical provider validation
    const canonicalMedia = await seerrClient.getMedia(payload.mediaType, payload.tmdbId);
    
    // 2. Check current state
    if (canonicalMedia.status !== "UNKNOWN" && canonicalMedia.status !== "PARTIALLY_AVAILABLE" && canonicalMedia.status !== "DELETED") {
      throw new Error(`Media is already in status: ${canonicalMedia.status}`);
    }

    // 3. Mutate
    return await seerrClient.requestMedia(payload.mediaType, payload.tmdbId, payload.seasons);
  }
}
