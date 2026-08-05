// Steam 商店公开接口数据层：搜索、详情、评测。无需 API Key。
// 带内存缓存与并发限制，避免触发商店限流。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const CACHE_TTL = Number(process.env.STEAM_CACHE_TTL_MS ?? 6 * 60 * 60 * 1000);
const CACHE_PATH = process.env.STEAM_CACHE_PATH || path.join(process.cwd(), ".cache", "steam.json");
const MAX_CACHE_ENTRIES = 5000;

interface CacheEntry {
  savedAt: number;
  data: unknown;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown | null>>();
let cacheLoaded = false;
let cacheLoadPromise: Promise<void> | null = null;
let persistPromise = Promise.resolve();

export interface SteamCacheStats {
  hits: number;
  misses: number;
  inFlightHits: number;
  networkRequests: number;
  failures: number;
}

const cacheStats: SteamCacheStats = { hits: 0, misses: 0, inFlightHits: 0, networkRequests: 0, failures: 0 };

export function steamCacheStats(): SteamCacheStats {
  return { ...cacheStats };
}

async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) return;
  if (!cacheLoadPromise) {
    cacheLoadPromise = (async () => {
      try {
        const parsed = JSON.parse(await readFile(CACHE_PATH, "utf8")) as Record<string, CacheEntry>;
        const now = Date.now();
        cache.clear();
        for (const [url, entry] of Object.entries(parsed)) {
          if (!entry || typeof entry.savedAt !== "number" || now - entry.savedAt >= CACHE_TTL) continue;
          cache.set(url, entry);
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

function setCache(url: string, data: unknown): void {
  cache.set(url, { savedAt: Date.now(), data });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
  void persistCache();
}

async function persistCache(): Promise<void> {
  const snapshot = Object.fromEntries(cache);
  persistPromise = persistPromise.then(async () => {
    await mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(snapshot), "utf8");
  }).catch(() => undefined);
  await persistPromise;
}

async function fetchJson<T>(url: string, timeoutMs = 12000, retries = 1): Promise<T | null> {
  await ensureCacheLoaded();
  const hit = cache.get(url);
  if (hit && Date.now() - hit.savedAt < CACHE_TTL) {
    cacheStats.hits += 1;
    return hit.data as T;
  }
  if (hit) cache.delete(url);

  const active = inFlight.get(url);
  if (active) {
    cacheStats.inFlightHits += 1;
    return await active as T | null;
  }
  cacheStats.misses += 1;

  const request = (async (): Promise<T | null> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        cacheStats.networkRequests += 1;
        const res = await fetch(url, { headers: UA, signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as T;
        setCache(url, data);
        return data;
      } catch {
        cacheStats.failures += 1;
        if (attempt === retries) return null;
        await new Promise((r) => setTimeout(r, 600));
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  })();

  inFlight.set(url, request as Promise<unknown | null>);
  try {
    return await request;
  } finally {
    inFlight.delete(url);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- 类型 ----------

interface StoreSearchItem {
  type?: string;
  id?: number;
  name?: string;
}

export interface StoreSearchResult {
  id: number;
  name: string;
}

export interface SteamAppData {
  type?: string;
  name?: string;
  header_image?: string;
  short_description?: string;
  is_free?: boolean;
  developers?: string[];
  publishers?: string[];
  price_overview?: {
    final: number;
    discount_percent: number;
    final_formatted: string;
  };
  platforms?: { windows: boolean; mac: boolean; linux: boolean };
  metacritic?: { score: number };
  categories?: { id: number; description: string }[];
  genres?: { id: string; description: string }[];
  release_date?: { coming_soon: boolean; date: string };
}

// ---------- 搜索 ----------

export async function searchStore(query: string, count = 8): Promise<StoreSearchResult[]> {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(
    query
  )}&l=schinese&cc=cn`;
  const data = await fetchJson<{ items?: StoreSearchItem[] }>(url);
  if (!data?.items) return [];
  return data.items
    .filter((it): it is StoreSearchItem & { id: number } => it.type === "app" && typeof it.id === "number")
    .slice(0, count)
    .map((it) => ({ id: it.id, name: it.name?.trim() || String(it.id) }));
}

// ---------- 详情 ----------

// Steam 的 filters 参数很怪：name/type/short_description 等单独用会返回空，
// 必须走 basic 分组（含 name/type/short_description/header_image/is_free）。
const DETAIL_FILTERS =
  "basic,genres,categories,developers,publishers,release_date,price_overview,platforms,metacritic";

export async function getAppData(appid: number): Promise<SteamAppData | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese&cc=cn&filters=${DETAIL_FILTERS}`;
  const data = await fetchJson<Record<string, { success: boolean; data?: SteamAppData }>>(url);
  const entry = data?.[String(appid)];
  if (!entry?.success || !entry.data) return null;
  return entry.data;
}

export async function getAppDataBatch(appids: number[]): Promise<Map<number, SteamAppData>> {
  const map = new Map<number, SteamAppData>();
  await mapLimit(appids, 6, async (id) => {
    const data = await getAppData(id);
    if (data) map.set(id, data);
  });
  return map;
}

// ---------- 评测 ----------

export interface ReviewSummary {
  total_positive: number;
  total_negative: number;
  total_reviews: number;
}

export async function getReviewSummary(appid: number): Promise<ReviewSummary | null> {
  const url = `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`;
  const data = await fetchJson<{ success: number; query_summary?: ReviewSummary }>(url, 8000, 0);
  if (data?.success !== 1 || !data.query_summary) return null;
  return data.query_summary;
}

export async function getReviewSummaries(appids: number[]): Promise<Map<number, ReviewSummary>> {
  const map = new Map<number, ReviewSummary>();
  await mapLimit(appids, 5, async (id) => {
    const summary = await getReviewSummary(id);
    if (summary) map.set(id, summary);
  });
  return map;
}

// ---------- 推导 ----------

const PLAYER_MODE_IDS = new Set([1, 2, 9, 24, 27, 36, 37, 38, 39, 49]);

export function derivePlayerModes(app: SteamAppData): string[] {
  const modes: string[] = [];
  for (const category of app.categories ?? []) {
    if (!PLAYER_MODE_IDS.has(category.id)) continue;
    const label = category.description.trim();
    if (label && !modes.includes(label)) modes.push(label);
  }
  return modes;
}

export function parseReleaseTimestamp(dateStr?: string): number | null {
  if (!dateStr) return null;
  const cn = dateStr.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (cn) return Date.UTC(+cn[1], +cn[2] - 1, +cn[3]);
  const parsed = Date.parse(dateStr);
  return Number.isNaN(parsed) ? null : parsed;
}

export function reviewLabel(positiveRate: number, total: number): string {
  if (total < 50) return "评测较少";
  if (positiveRate >= 95 && total >= 500) return "好评如潮";
  if (positiveRate >= 80) return "特别好评";
  if (positiveRate >= 70) return "多半好评";
  if (positiveRate >= 40) return "褒贬不一";
  if (positiveRate >= 20) return "多半差评";
  return "差评如潮";
}
