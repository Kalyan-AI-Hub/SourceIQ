/**
 * src/lib/cache.ts — Shared typed cache service for SourceIQ
 *
 * Features:
 *  - Typed get/set/getOrCompute API
 *  - Per-entry TTL with metadata (createdAt, expiresAt, tags, source)
 *  - LRU eviction (max entries cap — no unbounded growth)
 *  - In-flight request coalescing (one recompute per key, not N stampedes)
 *  - Stale-while-revalidate (serve stale immediately, recompute in background)
 *  - Tag-based bulk invalidation
 *  - Stats (hits, misses, stale-hits, evictions)
 *  - Survives Next.js dev-mode hot reload via globalThis
 */

export type CacheTag = 'risk' | 'inventory' | 'tariff' | 'market' | 'brief' | 'ai-insight';

interface CacheEntry<T> {
  data: T;
  createdAt: number;
  expiresAt: number;
  /** stale-while-revalidate window end (ms epoch) — 0 means no SWR */
  swrUntil: number;
  tags: CacheTag[];
  source?: string;
  /** LRU tracking — updated on every access */
  lastAccessedAt: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  staleHits: number;
  recomputes: number;
  evictions: number;
  inflight: number;
  size: number;
}

const DEFAULT_MAX_ENTRIES = 256;

class SourceIQCache {
  private store = new Map<string, CacheEntry<unknown>>();
  /** In-flight promises — prevents stampede on concurrent misses for the same key */
  private inflight = new Map<string, Promise<unknown>>();
  private stats: CacheStats = { hits: 0, misses: 0, staleHits: 0, recomputes: 0, evictions: 0, inflight: 0, size: 0 };
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  // ── Core primitives ──────────────────────────────────────────────────

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    entry.lastAccessedAt = Date.now();
    return entry.data;
  }

  set<T>(
    key: string,
    data: T,
    opts: { ttlMs: number; swrMs?: number; tags?: CacheTag[]; source?: string },
  ): void {
    const now = Date.now();
    // Evict LRU entry if at capacity
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      this._evictLRU();
    }
    this.store.set(key, {
      data,
      createdAt: now,
      expiresAt: now + opts.ttlMs,
      swrUntil: opts.swrMs ? now + opts.ttlMs + opts.swrMs : 0,
      tags: opts.tags ?? [],
      source: opts.source,
      lastAccessedAt: now,
    });
    this.stats.size = this.store.size;
  }

  hasFresh(key: string): boolean {
    const entry = this.store.get(key);
    return !!entry && Date.now() < entry.expiresAt;
  }

  /** True if entry exists and is within the SWR window (stale but usable) */
  hasStale(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    const now = Date.now();
    return now >= entry.expiresAt && (entry.swrUntil === 0 || now < entry.swrUntil);
  }

  invalidate(key: string): void {
    this.store.delete(key);
    this.stats.size = this.store.size;
  }

  invalidateByPrefix(prefix: string): void {
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        this.stats.size = this.store.size;
      }
    }
  }

  invalidateByTag(tag: CacheTag): void {
    for (const [key, entry] of Array.from(this.store.entries())) {
      if (entry.tags.includes(tag)) {
        this.store.delete(key);
      }
    }
    this.stats.size = this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
    this.stats.size = 0;
  }

  getStats(): Readonly<CacheStats> {
    return { ...this.stats, inflight: this.inflight.size, size: this.store.size };
  }

  // ── getOrCompute — the main API ──────────────────────────────────────

  /**
   * Return cached value if fresh. If stale-while-revalidate is configured and
   * the entry is in the SWR window, return the stale value immediately and kick
   * off a background recompute. If fully expired (or missing), compute and cache.
   * Concurrent calls for the same key coalesce onto one in-flight promise.
   */
  async getOrCompute<T>(
    key: string,
    compute: () => Promise<T>,
    opts: { ttlMs: number; swrMs?: number; tags?: CacheTag[]; source?: string },
  ): Promise<T> {
    const now = Date.now();
    const entry = this.store.get(key) as CacheEntry<T> | undefined;

    // 1. Fresh hit
    if (entry && now < entry.expiresAt) {
      entry.lastAccessedAt = now;
      this.stats.hits++;
      return entry.data;
    }

    // 2. Stale-while-revalidate hit — return stale immediately, recompute in bg
    if (entry && opts.swrMs && now < entry.swrUntil) {
      entry.lastAccessedAt = now;
      this.stats.staleHits++;
      // Only start one background recompute per key
      if (!this.inflight.has(key)) {
        const bg = compute().then(fresh => {
          this.set(key, fresh, opts);
          this.inflight.delete(key);
        }).catch(() => this.inflight.delete(key));
        this.inflight.set(key, bg);
      }
      return entry.data;
    }

    // 3. Miss — coalesce concurrent requests onto one in-flight promise
    this.stats.misses++;
    if (this.inflight.has(key)) {
      return this.inflight.get(key) as Promise<T>;
    }

    this.stats.recomputes++;
    const promise = compute().then(result => {
      this.set(key, result, opts);
      this.inflight.delete(key);
      return result;
    }).catch(err => {
      this.inflight.delete(key);
      throw err;
    });

    this.inflight.set(key, promise);
    return promise;
  }

  // ── LRU eviction ────────────────────────────────────────────────────

  private _evictLRU(): void {
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [key, entry] of Array.from(this.store.entries())) {
      if (entry.lastAccessedAt < oldestTs) {
        oldestTs = entry.lastAccessedAt;
        oldest = key;
      }
    }
    if (oldest) {
      this.store.delete(oldest);
      this.stats.evictions++;
      this.stats.size = this.store.size;
    }
  }
}

// ── Singleton via globalThis (survives Next.js dev hot-reload) ──────────

declare global {
  // eslint-disable-next-line no-var
  var __sourceIQCacheV2: SourceIQCache | undefined;
}

if (!globalThis.__sourceIQCacheV2) {
  globalThis.__sourceIQCacheV2 = new SourceIQCache(256);
}

export const cache = globalThis.__sourceIQCacheV2;

// ── Convenience TTL constants ────────────────────────────────────────────

export const TTL = {
  /** Live data — SSE, heatmap stream (not cached via this module) */
  LIVE:    0,
  /** Short-lived — what-if, diversification, countries */
  SHORT:   5  * 60 * 1_000,
  /** Medium — morning brief, AI insights */
  MEDIUM:  10 * 60 * 1_000,
  /** Long — world brief, RSS, commodities, FX */
  LONG:    60 * 60 * 1_000,
  /** Very long — World Bank baselines */
  DAY:     24 * 60 * 60 * 1_000,
} as const;

/** SWR extension windows — how long to serve stale after TTL expires */
export const SWR = {
  SHORT:  2  * 60 * 1_000,   // 2 min stale window
  MEDIUM: 5  * 60 * 1_000,   // 5 min stale window
  LONG:   15 * 60 * 1_000,   // 15 min stale window
} as const;
