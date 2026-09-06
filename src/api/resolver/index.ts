import { SeerrClient } from "../../providers/seerr/client.js";
import { MediaCandidate } from "../../core/media.js";
import { IntentExtractor, MediaIntent } from "./intent.js";

export type ResolutionResult = {
  candidate: MediaCandidate;
  confidence: number;
  matchReason: string;
};

export class MediaResolver {
  constructor(
    private seerrClient: SeerrClient,
    private intentExtractor?: IntentExtractor
  ) {}

  async resolveMedia(query: string): Promise<ResolutionResult> {
    // 1. Native Seerr search (exact or very close match)
    const nativeResults = await this.seerrClient.search(query);
    if (nativeResults.length > 0) {
      const topMatch = nativeResults[0];
      // Basic heuristic for high confidence native match: exact title match
      if (topMatch.title.toLowerCase() === query.toLowerCase() || (topMatch.originalTitle && topMatch.originalTitle.toLowerCase() === query.toLowerCase())) {
        return {
          candidate: topMatch,
          confidence: 0.9,
          matchReason: "Exact title match via native Seerr search"
        };
      }
    }

    // 2. Normalized search (strip years, punctuation, etc - simple version)
    const normalizedQuery = query.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    if (normalizedQuery !== query && normalizedQuery.length > 0) {
      const normalizedResults = await this.seerrClient.search(normalizedQuery);
      if (normalizedResults.length > 0) {
        const topMatch = normalizedResults[0];
        if (topMatch.title.toLowerCase() === normalizedQuery.toLowerCase() || (topMatch.originalTitle && topMatch.originalTitle.toLowerCase() === normalizedQuery.toLowerCase())) {
          return {
            candidate: topMatch,
            confidence: 0.8,
            matchReason: "Normalized title match via native Seerr search"
          };
        }
      }
    }

    // 3. Fallback to Semantic Resolution (Nebius)
    if (!this.intentExtractor) {
      throw new Error("LLM_UNAVAILABLE: Native search yielded no confident results and semantic fallback is disabled.");
    }

    const intent = await this.intentExtractor.extract(query);

    // 4. Canonical Lookup via Seerr using the inferred title
    if (!intent.titleHint) {
      throw new Error("Semantic resolution failed: Could not determine a title hint from the query.");
    }

    const searchResults = await this.seerrClient.search(intent.titleHint);
    if (searchResults.length === 0) {
      throw new Error("Semantic resolution failed: No TMDB candidates found for the inferred title.");
    }

    // 5. Ranking and Verification
    return this.rankCandidates(intent, searchResults);
  }

  private rankCandidates(intent: MediaIntent, candidates: MediaCandidate[]): ResolutionResult {
    // Basic MVP ranking implementation
    // We prioritize candidates that match the mediaType and year (if provided)
    let bestCandidate = candidates[0];
    let highestScore = 0;

    for (const candidate of candidates) {
      let score = 0;

      // Base score for simply being the top result from Seerr
      if (candidate === candidates[0]) score += 0.5;

      if (intent.mediaType && candidate.mediaType === intent.mediaType) {
        score += 0.2;
      }

      if (intent.year && candidate.year === intent.year) {
        score += 0.3;
      }

      if (score > highestScore) {
        highestScore = score;
        bestCandidate = candidate;
      }
    }

    const confidence = Math.min(0.99, 0.5 + highestScore);
    const reasonParts = ["Matched semantic intent"];
    if (intent.titleHint) reasonParts.push(`titleHint: '${intent.titleHint}'`);
    if (intent.mediaType) reasonParts.push(`mediaType: '${intent.mediaType}'`);
    if (intent.year) reasonParts.push(`year: ${intent.year}`);

    return {
      candidate: bestCandidate,
      confidence: confidence,
      matchReason: reasonParts.join(", ")
    };
  }
}
