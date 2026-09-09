import { SeerrClient } from "../../providers/seerr/client.js";
import { MediaCandidate } from "../../core/media.js";
import { IntentExtractor, MediaIntent } from "./intent.js";

export type ResolutionResult = {
  candidate: MediaCandidate;
  confidence: number;
  matchReason: string;
};

/**
 * Where the search term that found this candidate came from. It caps the
 * confidence, because how the title was arrived at matters more than how well
 * the candidate scores: the top result for a term is always the top result,
 * even when the term itself was worthless.
 */
type Provenance = "stated" | "recognised" | "similar" | "echo";

/**
 * The most a result can claim, before agreement with the rest of the intent is
 * taken into account. `echo` is the case where the model handed back the
 * query instead of a title; whatever Seerr returns for it is a coincidence, and
 * the number has to say so.
 */
const CEILING: Record<Provenance, number> = {
  stated: 0.9,
  recognised: 0.85,
  similar: 0.6,
  echo: 0.4,
};

const REASON: Record<Provenance, string> = {
  stated: "title taken from the query",
  recognised: "title inferred from the description",
  similar: "nearest work the description matched",
  echo: "the model returned the query instead of a title",
};

/** Case- and punctuation-insensitive, so "The Matrix!" and "the matrix" are one term. */
function normalise(value: string): string {
  return value.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase();
}

export class MediaResolver {
  constructor(
    private seerrClient: SeerrClient,
    private intentExtractor?: IntentExtractor
  ) {}

  async resolveMedia(query: string): Promise<ResolutionResult> {
    // Every term searched, with what it returned. Reused rather than re-issued:
    // the model often hands back a term already tried, and a second identical
    // request to Seerr cannot produce a different answer.
    const searched = new Map<string, MediaCandidate[]>();
    const search = async (term: string): Promise<MediaCandidate[]> => {
      const key = normalise(term);
      const cached = searched.get(key);
      if (cached) return cached;
      const results = await this.seerrClient.search(term);
      searched.set(key, results);
      return results;
    };

    // 1. Native Seerr search (exact or very close match)
    const nativeResults = await search(query);
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
      const normalizedResults = await search(normalizedQuery);
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

    // 4. Canonical lookup, best term first. similarTo is tried when titleHint
    // finds nothing, because a model that will not commit to a title often
    // still names the right work there.
    const terms = lookupTerms(intent, query);
    if (terms.length === 0) {
      throw new Error("Semantic resolution failed: Could not determine a title hint from the query.");
    }

    for (const { term, provenance } of terms) {
      const results = await search(term);
      if (results.length > 0) return rankCandidates(intent, results, provenance);
    }

    throw new Error("Semantic resolution failed: No TMDB candidates found for the inferred title.");
  }
}

/**
 * The terms worth searching, in the order worth searching them.
 *
 * A titleHint that only repeats the query is kept rather than dropped — it
 * still reaches whatever the query itself returned, and that beats refusing to
 * answer — but it is marked `echo` so it cannot claim a high confidence.
 */
function lookupTerms(intent: MediaIntent, query: string): Array<{ term: string; provenance: Provenance }> {
  const terms: Array<{ term: string; provenance: Provenance }> = [];
  const seen = new Set<string>();
  const add = (term: string | undefined, provenance: Provenance) => {
    if (!term) return;
    const key = normalise(term);
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    terms.push({ term, provenance });
  };

  const echoesQuery = intent.titleHint !== undefined && normalise(intent.titleHint) === normalise(query);
  const provenance: Provenance = echoesQuery
    ? "echo"
    : intent.titleSource === "stated"
      ? "stated"
      : "recognised";

  // "unknown" is the model saying it did not identify the work. Whatever landed
  // in titleHint then is a description, not an answer, so the work it named as
  // closest is the better lead and goes first.
  if (intent.titleSource === "unknown") {
    add(intent.similarTo, "similar");
    add(intent.titleHint, "echo");
    return terms;
  }

  add(intent.titleHint, provenance);
  add(intent.similarTo, "similar");
  return terms;
}

/**
 * Picks the best candidate and says how much to trust it.
 *
 * The score only orders the candidates. The confidence comes from the ceiling
 * for how the search term was obtained, reduced where the chosen candidate
 * contradicts the rest of the intent. The previous version added a flat 0.5 for
 * being the first result Seerr returned and capped at 0.99, so a candidate that
 * agreed with nothing still reported 0.99 — which it did for
 * "A Short Manual of Linguistic Anarchism" against a query about Arrival.
 */
function rankCandidates(intent: MediaIntent, candidates: MediaCandidate[], provenance: Provenance): ResolutionResult {
  let bestCandidate = candidates[0];
  let highestScore = -1;

  for (const candidate of candidates) {
    // Being first is a tiebreaker, not evidence. It used to be worth as much as
    // agreeing with the whole intent, which let Seerr's top hit for a term beat
    // the candidate that actually matched the year and the media type.
    let score = 0;
    if (candidate === candidates[0]) score += 0.15;
    if (intent.mediaType && candidate.mediaType === intent.mediaType) score += 0.35;
    if (intent.year && candidate.year === intent.year) score += 0.5;

    if (score > highestScore) {
      highestScore = score;
      bestCandidate = candidate;
    }
  }

  let confidence = CEILING[provenance];
  const disagreements: string[] = [];
  if (intent.mediaType && bestCandidate.mediaType !== intent.mediaType) {
    confidence -= 0.2;
    disagreements.push(`expected a ${intent.mediaType}`);
  }
  if (intent.year && bestCandidate.year !== intent.year) {
    confidence -= 0.2;
    disagreements.push(`expected ${intent.year}`);
  }
  if (bestCandidate !== candidates[0]) confidence -= 0.05;
  confidence = Math.max(0.1, Math.round(confidence * 100) / 100);

  const reasonParts = [REASON[provenance]];
  if (intent.titleHint) reasonParts.push(`titleHint: '${intent.titleHint}'`);
  if (provenance === "similar" && intent.similarTo) reasonParts.push(`similarTo: '${intent.similarTo}'`);
  if (intent.mediaType) reasonParts.push(`mediaType: '${intent.mediaType}'`);
  if (intent.year) reasonParts.push(`year: ${intent.year}`);
  reasonParts.push(...disagreements);

  return {
    candidate: bestCandidate,
    confidence,
    matchReason: reasonParts.join(", "),
  };
}
