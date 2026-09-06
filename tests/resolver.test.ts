import { test, expect, vi } from "vitest";
import { MediaResolver } from "../src/api/resolver/index.js";
import { IntentExtractor, MediaIntent } from "../src/api/resolver/intent.js";

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
  expect(result.matchReason).toContain("Matched semantic intent");
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
