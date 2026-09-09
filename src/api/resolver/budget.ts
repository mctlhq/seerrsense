import type { AuthStore } from "../../auth/store.js";
import type { IntentExtractor, MediaIntent } from "./intent.js";

/** Reserved subject for the global ceiling. No real subject collides with it:
 * every one is `google:<sub>` or `static-token`. */
const GLOBAL_SUBJECT = "__global__";
/** Used for the legacy shared token and stdio mode, which have no OAuth subject. */
const UNAUTHENTICATED_SUBJECT = "static-token";

const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 10 * 60 * 1000;

export class ResolveBudgetError extends Error {
  constructor(message = "You have reached today's limit for resolve_media. Try again tomorrow.") {
    super(message);
    this.name = "ResolveBudgetError";
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Case- and punctuation-insensitive, matching resolver/index.ts's own normalise(). */
function normaliseQuery(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

interface CacheEntry {
  value: MediaIntent;
  expiresAt: number;
}

/**
 * Bounded LRU keyed on the normalised query. Process-local and shared across
 * every `BudgetedIntentExtractor` instance: a hit is safe to share across
 * subjects because the key is the query the caller supplied, so a hit
 * returns only what that caller already asked for.
 */
class IntentCache {
  private map = new Map<string, CacheEntry>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): MediaIntent | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Re-inserting moves the entry to the end, so iteration order tracks
    // recency for the eviction below.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: MediaIntent): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

const sharedCache = new IntentCache(CACHE_MAX_ENTRIES, CACHE_TTL_MS);

export interface ResolveBudgetOptions {
  dailyLimit: number;
  globalDailyLimit: number;
}

/**
 * Wraps a model-backed `IntentExtractor` with a cache and a daily budget, so
 * a resolve_media call that a cache hit or native Seerr search already
 * answered never reaches the model, and one that does is metered per subject
 * and globally.
 *
 * Counting at this boundary rather than at the tool boundary means only a
 * query that actually invokes the model costs budget: `MediaResolver` never
 * calls `extract()` when its own native-search steps already found an
 * answer.
 */
export class BudgetedIntentExtractor implements IntentExtractor {
  constructor(
    private readonly inner: IntentExtractor,
    private readonly store: AuthStore,
    private readonly subject: string | undefined,
    private readonly options: ResolveBudgetOptions,
  ) {}

  async extract(query: string): Promise<MediaIntent> {
    const key = normaliseQuery(query);
    const cached = sharedCache.get(key);
    if (cached) return cached;

    const allowed = await this.consume();
    if (!allowed) throw new ResolveBudgetError();

    const intent = await this.inner.extract(query);
    sharedCache.set(key, intent);
    return intent;
  }

  /** Checks and increments the per-subject cap before the global one, so a
   * subject already over its own cap does not also inflate the global
   * counter with attempts that were going to be refused anyway. */
  private async consume(): Promise<boolean> {
    const day = todayUtc();
    const subjectKey = this.subject ?? UNAUTHENTICATED_SUBJECT;
    const subjectCount = await this.store.countResolve(subjectKey, day);
    if (subjectCount > this.options.dailyLimit) return false;
    const globalCount = await this.store.countResolve(GLOBAL_SUBJECT, day);
    if (globalCount > this.options.globalDailyLimit) return false;
    return true;
  }
}
