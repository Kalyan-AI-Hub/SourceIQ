// src/services/riskCache.ts — TTL cache with staleness metadata
// Used by riskPoller to cache SRI scores between 5-min refresh cycles.

import type { CacheEntry } from '../types/index';

export class RiskCache<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();

  constructor(private readonly ttlSeconds: number) {}

  set(key: string, data: T, recordCount = 1): void {
    this.cache.set(key, {
      data,
      fetchedAt: new Date().toISOString(),
      ttlSeconds: this.ttlSeconds,
      recordCount,
      isStale: false,
    });
  }

  get(key: string): CacheEntry<T> | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const ageSeconds = (Date.now() - new Date(entry.fetchedAt).getTime()) / 1000;
    entry.isStale = ageSeconds > this.ttlSeconds;
    return entry;
  }

  /** Returns data directly, or null if cache miss */
  getData(key: string): T | null {
    return this.get(key)?.data ?? null;
  }

  isStale(key: string): boolean {
    const entry = this.get(key);
    return entry?.isStale ?? true;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}
