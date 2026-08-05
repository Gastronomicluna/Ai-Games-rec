import { createHash } from "node:crypto";

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
let hits = 0;
let misses = 0;

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function cacheKey(scope: string, payload: unknown): string {
  return `${scope}:${createHash("sha256").update(stableSerialize(payload)).digest("hex")}`;
}

export async function getCachedLlmResult<T>(
  scope: string,
  payload: unknown,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<{ value: T; cacheHit: boolean }> {
  pruneCache();
  const key = cacheKey(scope, payload);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    hits += 1;
    return { value: cached.value as T, cacheHit: true };
  }
  if (cached) cache.delete(key);

  const active = inFlight.get(key);
  if (active) {
    hits += 1;
    return { value: await active as T, cacheHit: true };
  }

  misses += 1;
  const request = loader();
  inFlight.set(key, request);
  try {
    const value = await request;
    cache.set(key, { expiresAt: Date.now() + ttlMs, value });
    pruneCache();
    return { value, cacheHit: false };
  } finally {
    inFlight.delete(key);
  }
}

export function llmCacheStats(): { entries: number; inFlight: number; hits: number; misses: number; hitRate: number } {
  const total = hits + misses;
  return { entries: cache.size, inFlight: inFlight.size, hits, misses, hitRate: total > 0 ? hits / total : 0 };
}
