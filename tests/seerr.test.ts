import { describe, it, expect, vi, beforeEach } from "vitest";
import { SeerrClient } from "../src/providers/seerr/client.js";
import { config } from "../src/core/config.js";

global.fetch = vi.fn();


describe("SeerrClient", () => {
  let client: SeerrClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SeerrClient("http://fake", "key", "ru-RU");
  });

  it("should map statuses correctly 1..7", async () => {
    const statuses = [
      { code: 1, text: "UNKNOWN" },
      { code: 2, text: "PENDING" },
      { code: 3, text: "PROCESSING" },
      { code: 4, text: "PARTIALLY_AVAILABLE" },
      { code: 5, text: "AVAILABLE" },
      { code: 6, text: "BLOCKLISTED" },
      { code: 7, text: "DELETED" },
      { code: 99, text: "UNKNOWN" } // Fallback
    ];

    for (const { code, text } of statuses) {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 1,
          mediaType: "movie",
          title: "Test",
          mediaInfo: { status: code }
        })
      });
      
      const result = await client.getMedia("movie", 1);
      expect(result.status).toBe(text);
    }
  });

  it("should throw on 4xx/5xx Seerr responses", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found"
    });

    await expect(client.getMedia("movie", 999999)).rejects.toThrow("Seerr API error: 404 Not Found");
  });

  it("should filter out non-movie/tv items in search", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { id: 1, mediaType: "person", name: "Christopher Nolan" },
          { id: 2, mediaType: "movie", title: "Inception", mediaInfo: { status: 1 } }
        ]
      })
    });

    const results = await client.search("Nolan");
    expect(results).toHaveLength(1);
    expect(results[0].mediaType).toBe("movie");
    expect(results[0].title).toBe("Inception");
  });

  it("should correctly handle tv season request", async () => {
    let capturedBody: any;
    (global.fetch as any).mockImplementation(async (url: string, options: any) => {
      capturedBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ success: true }) };
    });

    await client.requestMedia("tv", 123, [1, 2]);
    expect(capturedBody).toEqual({ mediaType: "tv", mediaId: 123, seasons: [1, 2] });

    await client.requestMedia("tv", 124);
    expect(capturedBody).toEqual({ mediaType: "tv", mediaId: 124, seasons: "all" });
  });

  it("should send Cloudflare Access headers only when configured", async () => {
    const captured: Record<string, string>[] = [];
    (global.fetch as any).mockImplementation(async (_url: string, options: any) => {
      captured.push(options.headers);
      return { ok: true, json: async () => ({ results: [] }) };
    });

    const saved = { id: config.CF_ACCESS_CLIENT_ID, secret: config.CF_ACCESS_CLIENT_SECRET };
    try {
      config.CF_ACCESS_CLIENT_ID = undefined;
      config.CF_ACCESS_CLIENT_SECRET = undefined;
      await client.search("x");
      expect(captured[0]).not.toHaveProperty("CF-Access-Client-Id");
      expect(captured[0]).not.toHaveProperty("CF-Access-Client-Secret");

      config.CF_ACCESS_CLIENT_ID = "cf-id";
      config.CF_ACCESS_CLIENT_SECRET = "cf-secret";
      await client.search("x");
      expect(captured[1]["CF-Access-Client-Id"]).toBe("cf-id");
      expect(captured[1]["CF-Access-Client-Secret"]).toBe("cf-secret");
      expect(captured[1]["X-Api-Key"]).toBe("key");
    } finally {
      config.CF_ACCESS_CLIENT_ID = saved.id;
      config.CF_ACCESS_CLIENT_SECRET = saved.secret;
    }
  });
});
