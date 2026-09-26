import type { MediaCandidate } from "./media.js";
import { parseMediaQuery } from "./query.js";

/** One Seerr search for one term: SeerrClient.search, or a caching wrapper around it. */
export type SearchTerm = (term: string) => Promise<MediaCandidate[]>;

/** Case- and punctuation-insensitive, so "Wonder Woman 1984" and "wonder woman: 1984" are one title. */
export function normaliseTitle(value: string | null | undefined): string {
  return (value ?? "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase();
}

function titled(candidate: MediaCandidate, title: string): boolean {
  const wanted = normaliseTitle(title);
  return wanted !== "" && (normaliseTitle(candidate.title) === wanted || normaliseTitle(candidate.originalTitle) === wanted);
}

/**
 * A title search that understands a year: the term sent to Seerr is the
 * title alone, and candidates from that year come first.
 *
 * A bare trailing number may be part of the title ("Wonder Woman 1984"), so
 * then the query as written is searched too, and a candidate whose title is
 * the whole query, number included, stays first. Otherwise the year only
 * reorders: candidates from it lead, each half keeps Seerr's order, and
 * nothing is dropped. A parenthesised year is never part of a title, so that
 * case is one search.
 *
 * Candidates are de-duplicated by media type and TMDB id.
 */
export async function searchMedia(search: SearchTerm, query: string): Promise<MediaCandidate[]> {
  const parsed = parseMediaQuery(query);
  if (parsed.titleQuery === "") return [];

  const terms = parsed.yearWasBare ? [query, parsed.titleQuery] : [parsed.titleQuery];
  const lists = await Promise.all(terms.map((term) => search(term)));

  const seen = new Set<string>();
  const merged: MediaCandidate[] = [];
  for (const candidate of lists.flat()) {
    const key = `${candidate.mediaType}:${candidate.providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }

  if (parsed.yearHint === undefined) return merged;
  const numberIsTitle = parsed.yearWasBare ? merged.filter((c) => titled(c, query)) : [];
  const rest = merged.filter((c) => !numberIsTitle.includes(c));
  return [
    ...numberIsTitle,
    ...rest.filter((c) => c.year === parsed.yearHint),
    ...rest.filter((c) => c.year !== parsed.yearHint),
  ];
}
