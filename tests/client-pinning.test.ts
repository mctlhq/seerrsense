import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinnedLookup, SeerrClient } from "../src/providers/seerr/client.js";

/**
 * The DNS pinning is the whole check-then-connect defence: the guard approves
 * a set of addresses, and the connection must go to one of those and nothing
 * else, however the name resolves a second later. Every other test that
 * reaches an untrusted dial stubs global fetch, so none of them executes the
 * dispatcher — which means a silently dropped `dispatcher` option would not
 * fail anything. These two cases cover both halves: the callback's own
 * behaviour, and the fact that it actually reaches fetch.
 */
describe("untrusted dial pinning", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers only with guard-approved addresses and refuses when none are safe", () => {
    const approved = pinnedLookup(["93.184.216.34"]);

    const one = vi.fn();
    approved("media.example.com", {}, one);
    expect(one).toHaveBeenCalledWith(null, "93.184.216.34", 4);

    const all = vi.fn();
    approved("media.example.com", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);

    // A blocked address that somehow reached the pin list is re-checked here,
    // so the connection is refused rather than made.
    const poisoned = pinnedLookup(["10.0.0.5"]);
    const refused = vi.fn();
    poisoned("media.example.com", {}, refused);
    expect(refused.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(refused.mock.calls[0][1]).toBeUndefined();
  });

  it("passes a pinned dispatcher and never follows a redirect", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ displayName: "someone" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new SeerrClient({
      baseUrl: "https://media.example.com",
      apiKey: "k",
      untrusted: true,
      lookup: async () => ["93.184.216.34"],
    });
    await client.describeSelf();
    await client.close();

    expect(seen).toHaveLength(1);
    const init = seen[0] as RequestInit & { dispatcher?: unknown };
    expect(init.redirect).toBe("manual");
    expect(init.dispatcher).toBeInstanceOf(Agent);
  });

  it("stops reading an untrusted body at the ceiling instead of after it", async () => {
    // content-length is absent under chunked encoding, which the untrusted
    // host chooses, so a size check after response.text() would cap what is
    // returned having already buffered everything sent. The stream must be
    // metered as it arrives and cancelled at the ceiling.
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let produced = 0;
    let cancelled = false;
    vi.stubGlobal("fetch", async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          produced += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new SeerrClient({
      baseUrl: "https://media.example.com",
      apiKey: "k",
      untrusted: true,
      lookup: async () => ["93.184.216.34"],
    });
    await expect(client.describeSelf()).rejects.toThrow();
    await client.close();

    // Six 1 MiB chunks is the ceiling plus the one that crosses it; an
    // unmetered read of this endless stream would never stop.
    expect(produced).toBeLessThanOrEqual(8);
    expect(cancelled).toBe(true);
  });

  it("does not pin or guard the operator's own household client", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ displayName: "owner" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // A private address the guard would reject: the household client is
    // operator-configured and deliberately exempt.
    const household = new SeerrClient({ baseUrl: "http://127.0.0.1:5055", apiKey: "k" });
    await household.describeSelf();

    const init = seen[0] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
  });
});
