/**
 * What a title query says, separated from how it was written.
 *
 * Overseerr hands a search term to TMDB, which matches titles and knows
 * nothing about years written into the term: "Мошенники 2026" found nothing
 * while "Мошенники" found the 2026 film, and resolve_media then fell through
 * to the language model for a title it already had. A year is the most
 * natural thing a person or a model adds to a title, so it is taken out of
 * the term and kept as a hint instead.
 *
 * One parser for search_media, the REST search and resolve_media, so the
 * paths cannot drift apart again.
 */
export interface MediaQuery {
  /** What goes to Seerr: the query without its year and without any parenthesised span. */
  titleQuery: string;
  /** The release year the query named, if it named one. */
  yearHint?: number;
  /**
   * The year was a bare trailing number, not a parenthesised one. That is
   * ambiguous — "Wonder Woman 1984" is a title, not "Wonder Woman" from 1984
   * — so a caller searching should also try the query as written.
   */
  yearWasBare: boolean;
}

/** TMDB's earliest entries are from the 1870s; a few years ahead covers announced titles. */
const EARLIEST_YEAR = 1870;
const YEARS_AHEAD = 5;

function plausibleYear(value: number, now: Date): boolean {
  return value >= EARLIEST_YEAR && value <= now.getUTCFullYear() + YEARS_AHEAD;
}

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** What may sit between a title and a trailing year: "Title 2026", "Title, 2026", "Title – 2026". */
const SEPARATORS = new Set([" ", ",", "-", "–", "—"]);

/**
 * Splits off a trailing four-digit number, scanning back from the end once.
 * Deliberately not a regular expression: the obvious one,
 * /^(.*\p{L}.*?)[\s,–—-]+(\d{4})$/, backtracks quadratically on a long
 * query that does not end in a year, and the query is caller-controlled.
 * The title part must contain a letter, so "1917" and "2012" stay titles.
 */
function splitTrailingYear(text: string): { title: string; year: number } | undefined {
  const end = text.length;
  if (end < 6 || !/^\d{4}$/.test(text.slice(end - 4))) return undefined;
  let cut = end - 4;
  if (!SEPARATORS.has(text[cut - 1])) return undefined; // "Title2026" or "12026"
  while (cut > 0 && SEPARATORS.has(text[cut - 1])) cut--;
  const title = text.slice(0, cut);
  return /\p{L}/u.test(title) ? { title, year: Number(text.slice(end - 4)) } : undefined;
}

export function parseMediaQuery(query: string, now: Date = new Date()): MediaQuery {
  let yearHint: number | undefined;

  // Parenthesised spans never reach Overseerr: it answers 400 to a term with
  // a parenthesis in it (SeerrClient.searchTerm). An unclosed one runs to the
  // end, as before. A span that is only a year is the most common one, and
  // becomes the hint.
  let text = query.replace(/\(([^)]*)\)?/gu, (_span, inner: string | undefined) => {
    const year = /^\s*(\d{4})\s*$/u.exec(inner ?? "");
    if (year && yearHint === undefined && plausibleYear(Number(year[1]), now)) {
      yearHint = Number(year[1]);
    }
    return " ";
  });
  text = collapse(text);

  let yearWasBare = false;
  if (yearHint === undefined) {
    const split = splitTrailingYear(text);
    if (split && plausibleYear(split.year, now)) {
      yearHint = split.year;
      text = collapse(split.title);
      yearWasBare = true;
    }
  }

  return { titleQuery: text, yearHint, yearWasBare };
}
