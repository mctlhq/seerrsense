import { describe, test, expect, vi } from "vitest";
import { parseMediaQuery } from "../src/core/query.js";
import { searchMedia } from "../src/core/search.js";
import type { MediaCandidate } from "../src/core/media.js";

// Fixed, so "a few years ahead" does not move under the test.
const NOW = new Date("2026-09-26T00:00:00Z");

describe("parseMediaQuery", () => {
  test.each([
    ["Мошенники", { titleQuery: "Мошенники", yearHint: undefined, yearWasBare: false }],
    ["Мошенники 2026", { titleQuery: "Мошенники", yearHint: 2026, yearWasBare: true }],
    ["Мошенники (2026)", { titleQuery: "Мошенники", yearHint: 2026, yearWasBare: false }],
    ["Scammers 2026", { titleQuery: "Scammers", yearHint: 2026, yearWasBare: true }],
    ["Scammers, 2026", { titleQuery: "Scammers", yearHint: 2026, yearWasBare: true }],
    ["The Matrix (1999", { titleQuery: "The Matrix", yearHint: 1999, yearWasBare: false }],
    ["Dune (Part Two) 2024", { titleQuery: "Dune", yearHint: 2024, yearWasBare: true }],
  ])("%s", (query, expected) => {
    expect(parseMediaQuery(query, NOW)).toEqual(expected);
  });

  // Four digits that are the title, or part of it, stay where they are.
  test.each([
    ["1917"],
    ["2012"],
    ["Blade Runner 2049"], // 2049 is not a plausible release year yet
    ["2001: A Space Odyssey"],
  ])("%s keeps its number", (query) => {
    expect(parseMediaQuery(query, NOW)).toEqual({ titleQuery: query, yearHint: undefined, yearWasBare: false });
  });

  // The query is caller-controlled and unbounded; the trailing-year split
  // must stay linear on inputs that do not end in a year.
  test("a long query that is not a title with a year is parsed in linear time", () => {
    for (const hostile of ["a ".repeat(50_000), "a,".repeat(50_000) + "x", "a" + " -".repeat(50_000) + "1"]) {
      const started = performance.now();
      parseMediaQuery(hostile, NOW);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });

  test("Title12026 and 12026 are not a title with a year", () => {
    expect(parseMediaQuery("Title12026", NOW).yearHint).toBeUndefined();
    expect(parseMediaQuery("Title 12026", NOW).yearHint).toBeUndefined();
  });

  test("a bare trailing year that may be part of the title is flagged, not trusted", () => {
    expect(parseMediaQuery("Wonder Woman 1984", NOW)).toEqual({
      titleQuery: "Wonder Woman",
      yearHint: 1984,
      yearWasBare: true,
    });
  });
});

const candidate = (providerId: number, title: string, year: number, extra: Partial<MediaCandidate> = {}): MediaCandidate => ({
  provider: "tmdb",
  providerId,
  mediaType: "movie",
  title,
  year,
  status: "UNKNOWN",
  ...extra,
});

// What the household Seerr answered on 2026-09-26: the title finds the film,
// the title with a year finds nothing.
const FRAUDS = candidate(70902, "The Frauds", 2006, { mediaType: "tv", originalTitle: "Мошенники" });
const SCAMMERS = candidate(1659823, "Scammers", 2026, { originalTitle: "Мошенники", status: "AVAILABLE" });
const SERIES = candidate(294595, "Мошенники", 2023, { mediaType: "tv" });

function seerr(answers: Record<string, MediaCandidate[]>) {
  return vi.fn(async (term: string) => answers[term] ?? []);
}

describe("searchMedia", () => {
  test("Мошенники 2026 finds the 2026 film, first", async () => {
    const search = seerr({ "Мошенники": [FRAUDS, SCAMMERS, SERIES], "Мошенники 2026": [] });
    const results = await searchMedia(search, "Мошенники 2026");
    expect(results[0].providerId).toBe(1659823);
    expect(results.map((r) => r.providerId)).toEqual([1659823, 70902, 294595]);
    // The bare year may be part of a title, so the query as written is tried too.
    expect(search.mock.calls.map(([term]) => term).sort()).toEqual(["Мошенники", "Мошенники 2026"]);
  });

  test("Мошенники (2026) behaves identically, with one search", async () => {
    const search = seerr({ "Мошенники": [FRAUDS, SCAMMERS, SERIES] });
    const results = await searchMedia(search, "Мошенники (2026)");
    expect(results.map((r) => r.providerId)).toEqual([1659823, 70902, 294595]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  test("Мошенники without a year keeps Seerr's order", async () => {
    const search = seerr({ "Мошенники": [FRAUDS, SCAMMERS, SERIES] });
    expect((await searchMedia(search, "Мошенники")).map((r) => r.providerId)).toEqual([70902, 1659823, 294595]);
  });

  test("a title that ends in a number stays first even when another film is from that year", async () => {
    const ww84 = candidate(464052, "Wonder Woman 1984", 2020);
    const ww = candidate(297762, "Wonder Woman", 2017);
    const other1984 = candidate(9999, "Wonder Woman", 1984, { mediaType: "tv" });
    const search = seerr({ "Wonder Woman 1984": [ww84], "Wonder Woman": [ww, other1984, ww84] });
    const results = await searchMedia(search, "Wonder Woman 1984");
    expect(results.map((r) => r.providerId)).toEqual([464052, 9999, 297762]);
  });

  test("nothing is dropped and nothing is duplicated", async () => {
    const search = seerr({ "Scammers 2026": [SCAMMERS], "Scammers": [SCAMMERS, FRAUDS] });
    expect((await searchMedia(search, "Scammers 2026")).map((r) => r.providerId)).toEqual([1659823, 70902]);
  });

  test("an empty title searches nothing", async () => {
    const search = seerr({});
    expect(await searchMedia(search, "(2026)")).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });
});
