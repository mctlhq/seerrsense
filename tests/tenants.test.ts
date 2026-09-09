import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { seal } from "../src/auth/crypto.js";
import { MemoryAuthStore } from "../src/auth/store.js";
import { SeerrClient } from "../src/providers/seerr/client.js";
import { TenantResolver, notConnectedMessage } from "../src/providers/seerr/tenants.js";

const KEY = randomBytes(32);

function authFor(subject: string, email: string) {
  return {
    token: "t",
    clientId: "c",
    scopes: ["seerr:read"],
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    extra: { subject, email },
  } as any;
}

function household(overrides: Partial<SeerrClient> = {}) {
  return {
    search: vi.fn().mockResolvedValue([]),
    findUserIdByEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SeerrClient;
}

describe("resolving which Seerr a caller reaches", () => {
  it("uses the person's own instance when they have attached one", async () => {
    const store = new MemoryAuthStore();
    await store.putUserConnection({
      subject: "google:1",
      email: "one@example.com",
      seerrUrl: "https://one.example/",
      seerrApiKeySealed: seal("key-one", KEY),
      updatedAt: Date.now(),
    });
    const resolver = new TenantResolver(store, KEY, household());

    const tenant = await resolver.resolve(authFor("google:1", "one@example.com"));
    expect(tenant.source).toBe("own");
    // Not the household client, and the key came back out of the sealed value.
    expect((tenant.client as any).apiKey).toBe("key-one");
    expect((tenant.client as any).baseUrl).toBe("https://one.example");
  });

  it("keeps two people on their own instances", async () => {
    const store = new MemoryAuthStore();
    await store.putUserConnection({
      subject: "google:1", email: "one@example.com", seerrUrl: "https://one.example",
      seerrApiKeySealed: seal("key-one", KEY), updatedAt: Date.now(),
    });
    await store.putUserConnection({
      subject: "google:2", email: "two@example.com", seerrUrl: "https://two.example",
      seerrApiKeySealed: seal("key-two", KEY), updatedAt: Date.now(),
    });
    const resolver = new TenantResolver(store, KEY, household());

    const first = await resolver.resolve(authFor("google:1", "one@example.com"));
    const second = await resolver.resolve(authFor("google:2", "two@example.com"));
    expect((first.client as any).baseUrl).toBe("https://one.example");
    expect((second.client as any).baseUrl).toBe("https://two.example");
  });

  it("falls back to the household instance and attributes the request, for a listed owner", async () => {
    const store = new MemoryAuthStore();
    const shared = household({ findUserIdByEmail: vi.fn().mockResolvedValue(42) } as any);
    const resolver = new TenantResolver(store, KEY, shared, new Set(["three@example.com"]));

    const tenant = await resolver.resolve(authFor("google:3", "three@example.com"));
    expect(tenant.source).toBe("household");
    expect(tenant.client).toBe(shared);
    // On a shared key the request would otherwise be filed under the owner.
    expect(tenant.attributedUserId).toBe(42);
  });

  it("still resolves when the Seerr user lookup fails, for a listed owner", async () => {
    const shared = household({
      findUserIdByEmail: vi.fn().mockRejectedValue(new Error("boom")),
    } as any);
    const resolver = new TenantResolver(
      new MemoryAuthStore(),
      KEY,
      shared,
      new Set(["four@example.com"]),
    );

    const tenant = await resolver.resolve(authFor("google:4", "four@example.com"));
    expect(tenant.client).toBe(shared);
    expect(tenant.attributedUserId).toBeUndefined();
  });

  it("resolves a signed-in caller with no connection and no listed household address to none", async () => {
    const shared = household({ findUserIdByEmail: vi.fn().mockResolvedValue(99) } as any);
    const resolver = new TenantResolver(new MemoryAuthStore(), KEY, shared, new Set());

    const tenant = await resolver.resolve(authFor("google:9", "nine@example.com"));
    expect(tenant.source).toBe("none");
    expect(tenant.client).toBeUndefined();
  });

  it("offers the household instance to a signed-in caller whose address is listed", async () => {
    const shared = household({ findUserIdByEmail: vi.fn().mockResolvedValue(99) } as any);
    const resolver = new TenantResolver(
      new MemoryAuthStore(),
      KEY,
      shared,
      new Set(["ten@example.com"]),
    );

    const tenant = await resolver.resolve(authFor("google:10", "ten@example.com"));
    expect(tenant.source).toBe("household");
    expect(tenant.client).toBe(shared);
    expect(tenant.attributedUserId).toBe(99);
  });

  it("gives the legacy shared token and stdio the household instance", async () => {
    const shared = household();
    const resolver = new TenantResolver(new MemoryAuthStore(), KEY, shared);

    expect((await resolver.resolve(authFor("static-token", ""))).client).toBe(shared);
    expect((await resolver.resolve(undefined)).client).toBe(shared);
  });

  it("never lets the shared token reach a per-user connection", async () => {
    const store = new MemoryAuthStore();
    // A row under the legacy subject must not become a way to borrow somebody's
    // Seerr: the shared token is not a person and has no connection of its own.
    await store.putUserConnection({
      subject: "static-token", email: "", seerrUrl: "https://smuggled.example",
      seerrApiKeySealed: seal("key", KEY), updatedAt: Date.now(),
    });
    const shared = household();
    const resolver = new TenantResolver(store, KEY, shared);

    const tenant = await resolver.resolve(authFor("static-token", ""));
    expect(tenant.source).toBe("household");
    expect(tenant.client).toBe(shared);
  });

  it("agrees with itself: householdFallback and resolve().source never diverge", async () => {
    const shared = household({ findUserIdByEmail: vi.fn().mockResolvedValue(1) } as any);
    const resolver = new TenantResolver(
      new MemoryAuthStore(),
      KEY,
      shared,
      new Set(["listed@example.com"]),
    );

    const listed = await resolver.resolve(authFor("google:listed", "listed@example.com"));
    expect(resolver.householdFallback("listed@example.com", "google:listed")).toBe("household");
    expect(listed.source).toBe("household");

    const unlisted = await resolver.resolve(authFor("google:unlisted", "unlisted@example.com"));
    expect(resolver.householdFallback("unlisted@example.com", "google:unlisted")).toBe("none");
    expect(unlisted.source).toBe("none");
  });

  // The configuration the first version of this fix got wrong: with no
  // encryption key there is no per-user path, so resolve() admits an
  // unlisted signed-in subject to the shared instance without consulting
  // SEERRSENSE_HOUSEHOLD_EMAILS. The page must say the same thing, or it
  // tells someone nothing is connected while their assistant is served by
  // the household Seerr.
  it("agrees with itself with no encryption key, where the allowlist does not apply", async () => {
    const shared = household({ findUserIdByEmail: vi.fn().mockResolvedValue(1) } as any);
    const resolver = new TenantResolver(
      new MemoryAuthStore(),
      undefined,
      shared,
      new Set(["listed@example.com"]),
    );

    const unlisted = await resolver.resolve(authFor("google:unlisted", "unlisted@example.com"));
    expect(unlisted.source).toBe("household");
    expect(resolver.householdFallback("unlisted@example.com", "google:unlisted")).toBe("household");

    const listed = await resolver.resolve(authFor("google:listed", "listed@example.com"));
    expect(listed.source).toBe("household");
    expect(resolver.householdFallback("listed@example.com", "google:listed")).toBe("household");
  });

  // Same invariant from the other side: without a store there is likewise no
  // per-user path.
  it("agrees with itself with no store", async () => {
    const shared = household({ findUserIdByEmail: vi.fn().mockResolvedValue(1) } as any);
    const resolver = new TenantResolver(undefined, KEY, shared, new Set(["listed@example.com"]));

    const unlisted = await resolver.resolve(authFor("google:unlisted", "unlisted@example.com"));
    expect(unlisted.source).toBe("household");
    expect(resolver.householdFallback("unlisted@example.com", "google:unlisted")).toBe("household");
  });

  it("householdFallback makes no network call and does not touch the cache", async () => {
    const store = new MemoryAuthStore();
    const spy = vi.spyOn(store, "getUserConnection");
    const shared = household({ findUserIdByEmail: vi.fn().mockResolvedValue(1) } as any);
    const resolver = new TenantResolver(store, KEY, shared, new Set(["listed@example.com"]));

    expect(resolver.householdFallback("listed@example.com", "google:listed")).toBe("household");
    expect(shared.findUserIdByEmail).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();

    // A subsequent resolve() still costs a fresh lookup — the cache was not
    // pre-populated by the fallback check.
    await resolver.resolve(authFor("google:listed", "listed@example.com"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports nothing to talk to when there is no household instance", async () => {
    const resolver = new TenantResolver(new MemoryAuthStore(), KEY, undefined);
    const tenant = await resolver.resolve(authFor("google:5", "five@example.com"));
    expect(tenant.source).toBe("none");
    expect(tenant.client).toBeUndefined();
    expect(notConnectedMessage("https://seerrsense.test")).toContain("https://seerrsense.test/account");
  });

  it("caches per subject and forgets on demand", async () => {
    const store = new MemoryAuthStore();
    const spy = vi.spyOn(store, "getUserConnection");
    const resolver = new TenantResolver(store, KEY, household());

    await resolver.resolve(authFor("google:6", "six@example.com"));
    await resolver.resolve(authFor("google:6", "six@example.com"));
    // The MCP hot path must not read the database on every tool call.
    expect(spy).toHaveBeenCalledTimes(1);

    resolver.forget("google:6");
    await resolver.resolve(authFor("google:6", "six@example.com"));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not serve one person's Seerr to another out of the cache", async () => {
    const store = new MemoryAuthStore();
    await store.putUserConnection({
      subject: "google:7", email: "seven@example.com", seerrUrl: "https://seven.example",
      seerrApiKeySealed: seal("key-seven", KEY), updatedAt: Date.now(),
    });
    const shared = household();
    const resolver = new TenantResolver(store, KEY, shared, new Set(["eight@example.com"]));

    const seven = await resolver.resolve(authFor("google:7", "seven@example.com"));
    const eight = await resolver.resolve(authFor("google:8", "eight@example.com"));
    expect((seven.client as any).baseUrl).toBe("https://seven.example");
    expect(eight.client).toBe(shared);
  });
});

describe("filing a request", () => {
  it("passes the attributed user through to Seerr", async () => {
    const { MediaRequestService } = await import("../src/api/service.js");
    const client = {
      getMedia: vi.fn().mockResolvedValue({ status: "UNKNOWN" }),
      requestMedia: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as SeerrClient;

    await new MediaRequestService(client, 42).requestMediaSafely({ mediaType: "movie", tmdbId: 27205 });
    expect(client.requestMedia).toHaveBeenCalledWith("movie", 27205, undefined, 42);

    await new MediaRequestService(client).requestMediaSafely({ mediaType: "movie", tmdbId: 27205 });
    expect(client.requestMedia).toHaveBeenLastCalledWith("movie", 27205, undefined, undefined);
  });

  it("still refuses to request something already available", async () => {
    const { MediaRequestService } = await import("../src/api/service.js");
    const client = {
      getMedia: vi.fn().mockResolvedValue({ status: "AVAILABLE" }),
      requestMedia: vi.fn(),
    } as unknown as SeerrClient;

    await expect(
      new MediaRequestService(client, 42).requestMediaSafely({ mediaType: "movie", tmdbId: 1 }),
    ).rejects.toThrow(/AVAILABLE/);
    expect(client.requestMedia).not.toHaveBeenCalled();
  });
});
