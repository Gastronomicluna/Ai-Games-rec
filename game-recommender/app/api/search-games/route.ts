import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { searchStore } from "@/lib/steam";
import { searchWikidata } from "@/lib/wikidata";

export const runtime = "nodejs";

interface SearchResult {
  id: string;
  name: string;
}

interface SearchCacheEntry {
  savedAt: number;
  results: SearchResult[];
}

const CACHE_TTL = Number(process.env.GAME_SEARCH_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
const CACHE_PATH = process.env.GAME_SEARCH_CACHE_PATH || path.join(process.cwd(), ".cache", "game-search.json");
const MAX_CACHE_ENTRIES = 2000;
const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 30;
const cache = new Map<string, SearchCacheEntry>();
const inFlight = new Map<string, Promise<SearchResult[]>>();
let cacheLoaded = false;
let cacheLoadPromise: Promise<void> | null = null;
let persistPromise = Promise.resolve();
const cacheStats = { hits: 0, misses: 0, inFlightHits: 0, failures: 0 };

async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) return;
  if (!cacheLoadPromise) {
    cacheLoadPromise = (async () => {
      try {
        const parsed = JSON.parse(await readFile(CACHE_PATH, "utf8")) as Record<string, SearchCacheEntry>;
        const now = Date.now();
        for (const [key, entry] of Object.entries(parsed)) {
          if (!entry || typeof entry.savedAt !== "number" || !Array.isArray(entry.results) || now - entry.savedAt >= CACHE_TTL) continue;
          cache.set(key, entry);
        }
      } catch {
        cache.clear();
      } finally {
        cacheLoaded = true;
      }
    })();
  }
  await cacheLoadPromise;
}

function saveCache(key: string, results: SearchResult[]): void {
  cache.set(key, { savedAt: Date.now(), results });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
  const snapshot = Object.fromEntries(cache);
  persistPromise = persistPromise.then(async () => {
    await mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(snapshot), "utf8");
  }).catch(() => undefined);
  void persistPromise;
}

async function searchSources(query: string, limit: number): Promise<SearchResult[]> {
  const [steamResults, wikidataResults] = await Promise.all([
    searchStore(query, limit),
    searchWikidata(query, limit).catch(() => []),
  ]);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const result of steamResults) {
    const key = result.name.toLocaleLowerCase();
    if (!result.name || seen.has(key)) continue;
    seen.add(key);
    results.push({ id: `steam-${result.id}`, name: result.name });
  }
  for (const game of wikidataResults) {
    const key = game.name.toLocaleLowerCase();
    if (!game.name || seen.has(key)) continue;
    seen.add(key);
    results.push({ id: `wikidata-${game.id}`, name: game.name });
  }
  return results.slice(0, limit);
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json({ results: [] });
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isInteger(requestedLimit)
    ? Math.max(5, Math.min(MAX_RESULT_LIMIT, requestedLimit))
    : DEFAULT_RESULT_LIMIT;
  const cacheKey = `${q.toLocaleLowerCase()}:${limit}`;

  await ensureCacheLoaded();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL) {
    cacheStats.hits += 1;
    console.info(`[search-games] cache=hit key=${cacheKey} stats=${JSON.stringify(cacheStats)}`);
    return NextResponse.json({ results: cached.results, cached: true });
  }
  if (cached) cache.delete(cacheKey);

  const active = inFlight.get(cacheKey);
  if (active) {
    cacheStats.inFlightHits += 1;
    try {
      return NextResponse.json({ results: await active, cached: false });
    } catch {
      return NextResponse.json({ results: [], error: "\u641c\u7d22\u6682\u65f6\u4e0d\u53ef\u7528" }, { status: 500 });
    }
  }

  cacheStats.misses += 1;
  const searchPromise = searchSources(q, limit);
  inFlight.set(cacheKey, searchPromise);
  try {
    const results = await searchPromise;
    // Do not persist an empty response: upstream clients intentionally degrade
    // to [] on transient network failures, and caching that would hide later recovery.
    if (results.length > 0) saveCache(cacheKey, results);
    console.info(`[search-games] cache=miss key=${cacheKey} resultCount=${results.length} stats=${JSON.stringify(cacheStats)}`);
    return NextResponse.json({ results, cached: false });
  } catch {
    cacheStats.failures += 1;
    console.warn(`[search-games] failed key=${cacheKey} stats=${JSON.stringify(cacheStats)}`);
    return NextResponse.json({ results: [], error: "\u641c\u7d22\u6682\u65f6\u4e0d\u53ef\u7528" }, { status: 500 });
  } finally {
    inFlight.delete(cacheKey);
  }
}
