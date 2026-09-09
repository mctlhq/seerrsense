import { test, expect, vi } from "vitest";
import { MediaResolver } from "../src/api/resolver/index.js";
import type { IntentExtractor, MediaIntent } from "../src/api/resolver/intent.js";

test("MediaResolver fallback resolves 'фильм Нолана про сон во сне' to Inception", async () => {
  const mockIntentExtractor: IntentExtractor = {
    extract: async (query) => {
      return {
        mediaType: "movie",
        titleHint: "Inception",
        director: "Christopher Nolan",
        plotHint: "dream within a dream"
      };
    }
  };

  const mockSeerrClient = {
    search: vi.fn().mockImplementation(async (query: string) => {
      if (query === "фильм Нолана про сон во сне") {
        return []; // Native search fails
      }
      if (query === "Inception") {
        return [
          {
            id: 27205, // TMDB ID for Inception
            title: "Inception",
            originalTitle: "Inception",
            mediaType: "movie",
            releaseDate: "2010-07-15"
          }
        ];
      }
      return [];
    }),
    getMedia: vi.fn(),
    requestMedia: vi.fn(),
    status: vi.fn(),
  };

  const resolver = new MediaResolver(mockSeerrClient as any, mockIntentExtractor);

  const result = await resolver.resolveMedia("фильм Нолана про сон во сне");
  
  expect(result.candidate.id).toBe(27205);
  expect(result.candidate.title).toBe("Inception");
  expect(result.matchReason).toContain("title inferred from the description");
  expect(result.matchReason).toContain("titleHint: 'Inception'");
});

test("MediaResolver routing corpus passes without invoking extractor", async () => {
  const mockIntentExtractor: IntentExtractor = {
    extract: vi.fn().mockRejectedValue(new Error("Should not be called"))
  };

  const mockSeerrClient = {
    search: vi.fn().mockImplementation(async (query: string) => {
      if (query.toLowerCase() === "1+1") {
        return [
          {
            id: 77338, // The Intouchables
            title: "1+1",
            originalTitle: "Intouchables",
            mediaType: "movie",
            releaseDate: "2011-11-02"
          }
        ];
      }
      return [];
    }),
    getMedia: vi.fn(),
    requestMedia: vi.fn(),
    status: vi.fn(),
  };

  const resolver = new MediaResolver(mockSeerrClient as any, mockIntentExtractor);

  const result = await resolver.resolveMedia("1+1");
  
  expect(result.candidate.id).toBe(77338);
  expect(result.matchReason).toContain("Exact title match");
  expect(mockIntentExtractor.extract).not.toHaveBeenCalled();
});

// A resolution is only as good as the term it was found by, and the term is
// only as good as the model's willingness to name the work. These cases replay
// what the model actually returned in production before the prompt was
// rewritten, because that is the shape the resolver has to survive: a title
// that is really a restatement of the query, a title left out entirely, and a
// disclaimed title with the real answer stranded in similarTo.

function seerr(catalogue: Record<string, any[]>) {
  return {
    search: vi.fn(async (query: string) => catalogue[query.toLowerCase()] ?? []),
    getMedia: vi.fn(),
    requestMedia: vi.fn(),
    status: vi.fn(),
  };
}

const extractorReturning = (intent: MediaIntent): IntentExtractor => ({ extract: async () => intent });

test("a title that only repeats the query cannot report a confident match", async () => {
  const query = "a programmer learns the world is a simulation";
  const client = seerr({
    [query]: [{ id: 999, title: "Programmer", mediaType: "movie", year: 2013 }],
  });
  // Recorded from production: the model restated the query instead of naming
  // the film, and the old ranking reported 0.99 for whatever Seerr returned.
  const resolver = new MediaResolver(client as any, extractorReturning({
    mediaType: "movie",
    titleHint: query,
    year: 2003,
    plotHint: "A programmer discovers that reality is a simulated construct",
  }));

  const result = await resolver.resolveMedia(query);

  expect(result.candidate.title).toBe("Programmer");
  expect(result.confidence).toBeLessThanOrEqual(0.4);
  expect(result.matchReason).toContain("the model returned the query instead of a title");
  // The query was searched once, not twice: the echoed term is the same term.
  expect(client.search).toHaveBeenCalledTimes(1);
});

test("a disclaimed title hands over to the work the model named as closest", async () => {
  const query = "фильм про программиста который узнал что мир это симуляция";
  const client = seerr({
    [query]: [],
    "программист": [{ id: 999, title: "Programmer", mediaType: "movie", year: 2013 }],
    "матрица": [{ id: 603, title: "The Matrix", mediaType: "movie", year: 1999 }],
  });
  const resolver = new MediaResolver(client as any, extractorReturning({
    titleHint: "программист",
    titleSource: "unknown",
    similarTo: "Матрица",
    year: 2003,
  }));

  const result = await resolver.resolveMedia(query);

  expect(result.candidate.title).toBe("The Matrix");
  expect(result.matchReason).toContain("nearest work the description matched");
  // Named as merely the closest, and the year disagrees, so it must not read
  // like a recognition.
  expect(result.confidence).toBeLessThan(0.6);
});

test("a missing title falls back rather than failing outright", async () => {
  const query = "movie about a linguist who talks to aliens";
  const client = seerr({
    [query]: [],
    "arrival": [{ id: 329865, title: "Arrival", mediaType: "movie", year: 2016 }],
  });
  // Recorded from production: no titleHint at all, which used to throw
  // "Could not determine a title hint".
  const resolver = new MediaResolver(client as any, extractorReturning({
    mediaType: "movie",
    similarTo: "Arrival",
    plotHint: "A linguist is tasked with communicating with extraterrestrial beings",
  }));

  const result = await resolver.resolveMedia(query);
  expect(result.candidate.title).toBe("Arrival");
});

test("a recognised title outranks a merely similar one", async () => {
  const query = "the one where a chemistry teacher starts cooking meth";
  const client = seerr({
    [query]: [],
    "breaking bad": [{ id: 1396, title: "Breaking Bad", mediaType: "tv", year: 2008 }],
  });
  const resolver = new MediaResolver(client as any, extractorReturning({
    mediaType: "tv",
    titleHint: "Breaking Bad",
    titleSource: "recognised",
    year: 2008,
  }));

  const result = await resolver.resolveMedia(query);

  expect(result.candidate.title).toBe("Breaking Bad");
  expect(result.confidence).toBe(0.85);
  expect(result.matchReason).toContain("title inferred from the description");
});

test("no lead at all is an error, not a confident wrong answer", async () => {
  const query = "that film with the thing in it";
  const client = seerr({ [query]: [] });
  const resolver = new MediaResolver(client as any, extractorReturning({ titleSource: "unknown" }));

  await expect(resolver.resolveMedia(query)).rejects.toThrow("Could not determine a title hint");
});

test("no ranking outcome reports the old 0.99", async () => {
  const query = "a linguist and some aliens";
  const client = seerr({
    [query]: [],
    "arrival": [
      { id: 1, title: "A Short Manual of Linguistic Anarchism", mediaType: "movie", year: 1970 },
      { id: 329865, title: "Arrival", mediaType: "movie", year: 2016 },
    ],
  });
  const resolver = new MediaResolver(client as any, extractorReturning({
    mediaType: "movie",
    titleHint: "Arrival",
    titleSource: "recognised",
    year: 2016,
  }));

  const result = await resolver.resolveMedia(query);
  // Year agreement moves the pick off the top result, and the confidence says
  // so instead of claiming near certainty for whatever came back first.
  expect(result.candidate.title).toBe("Arrival");
  expect(result.confidence).toBeLessThan(0.9);
  expect(result.confidence).not.toBe(0.99);
});

// The model can fail to produce an intent at all. Asked "that film with the
// thing in it" it ran to 8514 tokens without ever closing the JSON object, the
// AI SDK retried, and the caller's request hung for minutes with no reply. An
// extractor that returns nothing has to read as "could not determine which
// work this is", promptly.
test("an extractor that yields nothing produces an error, not a hang", async () => {
  const query = "that film with the thing in it";
  const client = seerr({ [query]: [] });
  const resolver = new MediaResolver(client as any, extractorReturning({}));

  await expect(resolver.resolveMedia(query)).rejects.toThrow("Could not determine a title hint");
});
