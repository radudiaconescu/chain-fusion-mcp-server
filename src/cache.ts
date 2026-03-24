import { LRUCache } from 'lru-cache';

// Cache stores serialized JSON strings only — avoids LRU's value constraint issues
let cache: LRUCache<string, string> | null = null;

export function initCache(ttlMs: number): void {
  cache = new LRUCache<string, string>({ max: 500, ttl: ttlMs });
}

export function cacheGet<T>(key: string): T | undefined {
  return cache?.get(key) as T | undefined;
}

export function cacheSet(key: string, value: string): void {
  cache?.set(key, value);
}

export function makeCacheKey(tool: string, params: Record<string, unknown>): string {
  return `${tool}:${JSON.stringify(params)}`;
}
