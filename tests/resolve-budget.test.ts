import { describe, it, expect, vi } from "vitest";
import { MemoryAuthStore } from "../src/auth/store.js";
import { BudgetedIntentExtractor, ResolveBudgetError } from "../src/api/resolver/budget.js";
import type { IntentExtractor, MediaIntent } from "../src/api/resolver/intent.js";

function fakeExtractor(intent: MediaIntent = { titleHint: "The Matrix" }) {
  return {
    extract: vi.fn().mockResolvedValue(intent),
  } as unknown as IntentExtractor & { extract: ReturnType<typeof vi.fn> };
}

// The intent cache inside budget.ts is a module-level singleton, shared
// across every BudgetedIntentExtractor instance on purpose (it is safe to
// share: the key is the query text itself). That means it is also shared
// across test cases in this file, so every query below must be unique to
// this test run or an earlier test's cache entry would silently absorb a
// call this test means to charge against the budget.
let queryId = 0;
function uniqueQuery(label: string): string {
  queryId += 1;
  return `${label} ${queryId}`;
}

describe("BudgetedIntentExtractor", () => {
  it("refuses the (N+1)th call for one subject without invoking the model", async () => {
    const inner = fakeExtractor();
    const store = new MemoryAuthStore();
    const budgeted = new BudgetedIntentExtractor(inner, store, "google:1", {
      dailyLimit: 2,
      globalDailyLimit: 1000,
    });

    await budgeted.extract(uniqueQuery("q"));
    await budgeted.extract(uniqueQuery("q"));
    await expect(budgeted.extract(uniqueQuery("q"))).rejects.toBeInstanceOf(ResolveBudgetError);
    expect(inner.extract).toHaveBeenCalledTimes(2);
  });

  it("refuses a second subject once the global ceiling is reached", async () => {
    const inner = fakeExtractor();
    const store = new MemoryAuthStore();
    const options = { dailyLimit: 100, globalDailyLimit: 1 };

    const first = new BudgetedIntentExtractor(inner, store, "google:1", options);
    await first.extract(uniqueQuery("q"));

    const second = new BudgetedIntentExtractor(inner, store, "google:2", options);
    await expect(second.extract(uniqueQuery("q"))).rejects.toBeInstanceOf(ResolveBudgetError);
  });

  it("serves a repeated normalised query from cache without a second model call or budget unit", async () => {
    const inner = fakeExtractor();
    const store = new MemoryAuthStore();
    const budgeted = new BudgetedIntentExtractor(inner, store, "google:3", {
      dailyLimit: 1,
      globalDailyLimit: 1000,
    });

    const query = uniqueQuery("The Matrix!");
    const first = await budgeted.extract(query);
    const second = await budgeted.extract(query.toLowerCase().replace("!", ""));
    expect(second).toEqual(first);
    expect(inner.extract).toHaveBeenCalledTimes(1);

    // The one unit of budget was spent on the first call; a second, distinct
    // query must still be refused since the cap is 1.
    await expect(budgeted.extract(uniqueQuery("q"))).rejects.toBeInstanceOf(ResolveBudgetError);
  });

  it("keys the legacy shared token and stdio mode (no subject) under a stable bucket", async () => {
    const inner = fakeExtractor();
    const store = new MemoryAuthStore();
    const budgeted = new BudgetedIntentExtractor(inner, store, undefined, {
      dailyLimit: 1,
      globalDailyLimit: 1000,
    });

    await budgeted.extract(uniqueQuery("q"));
    await expect(budgeted.extract(uniqueQuery("q"))).rejects.toBeInstanceOf(ResolveBudgetError);
  });
});

describe("MemoryAuthStore resolve usage counters", () => {
  it("increments atomically and returns the running total", async () => {
    const store = new MemoryAuthStore();
    expect(await store.countResolve("google:1", "2026-01-01")).toBe(1);
    expect(await store.countResolve("google:1", "2026-01-01")).toBe(2);
    expect(await store.countResolve("google:1", "2026-01-02")).toBe(1);
  });

  it("purges only days before the cutoff", async () => {
    const store = new MemoryAuthStore();
    await store.countResolve("google:1", "2026-01-01");
    await store.countResolve("google:1", "2026-01-10");
    await store.purgeResolveUsage("2026-01-05");
    expect(await store.countResolve("google:1", "2026-01-01")).toBe(1);
    expect(await store.countResolve("google:1", "2026-01-10")).toBe(2);
  });
});
