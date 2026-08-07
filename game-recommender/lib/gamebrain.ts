import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://api.gamebrain.co/v1";
// GameBrain's terms cap cached API responses at one hour unless separately approved.
const CACHE_TTL = Number(process.env.GAMEBRAIN_CACHE_TTL_MS ?? 60 * 60 * 1000);
const MIN_REQUEST_INTERVAL = Number(process.env.GAMEBRAIN_MIN_REQUEST_INTERVAL_MS ?? 1050);
const CACHE_PATH = process.env.GAMEBRAIN_CACHE_PATH || path.join(process.cwd(), ".cache", "gamebrain.json");

export interface GameBrainRating {
  mean?: number;
  count?: number;
}

export interface GameBrainGame {
  id: number;
  year?: number;
  name: string;
  genre?: string;
  image?: string;
  link?: string;
  rating?: GameBrainRating;
  adult_only?: boolean;
  screenshots?: string[];
  short_description?: string;
  platforms?: GameBrainNamedValue[];
  genres?: GameBrainNamedValue[];
  play_modes?: GameBrainNamedValue[];
}

export interface GameBrainNamedValue {
  value: string;
  name: string;
}

export interface GameBrainSearchFilter {
  key: string;
  values: { value: string }[];
  connection?: "AND" | "OR";
}

export interface GameBrainSearchOptions {
  filters?: GameBrainSearchFilter[];
  sort?: "computed_rating" | "release_date" | "price";
  sortOrder?: "asc" | "desc";
  generateFilterOptions?: boolean;
  /** Stop as soon as this many raw results are available. */
  minimumResults?: number;
  /** Hard request cap for this search. */
  maxPages?: number;
  /** Shared conservative Search-token budget across recommendation rounds. */
  requestBudget?: GameBrainSearchBudget;
}

export interface GameBrainSearchBudget {
  remaining: number;
  used: number;
}

interface SearchResponse {
  total_results?: number;
  limit?: number;
  offset?: number;
  results?: GameBrainGame[];
}

interface CacheRecord {
  savedAt: number;
  data: unknown;
}

export class GameBrainUnavailableError extends Error {
  constructor(message = "GameBrain 游戏库当前不可用") {
    super(message);
    this.name = "GameBrainUnavailableError";
  }
}

export class GameBrainQuotaError extends Error {
  constructor(message = "GameBrain 今日免费额度不足") {
    super(message);
    this.name = "GameBrainQuotaError";
  }
}

let requestQueue = Promise.resolve();
let lastRequestAt = 0;
let cacheLoaded = false;
let cacheLoadPromise: Promise<void> | null = null;
let cache = new Map<string, CacheRecord>();
const inFlight = new Map<string, Promise<unknown>>();
let quotaLeft: number | null = null;
let persistPromise = Promise.resolve();

export interface GameBrainCacheStats {
  hits: number;
  misses: number;
  inFlightHits: number;
  networkRequests: number;
  quotaTokens: number;
  failures: number;
}

const cacheStats: GameBrainCacheStats = { hits: 0, misses: 0, inFlightHits: 0, networkRequests: 0, quotaTokens: 0, failures: 0 };

export function gameBrainCacheStats(): GameBrainCacheStats {
  return { ...cacheStats };
}

export function isGameBrainConfigured(): boolean {
  return Boolean(process.env.GAMEBRAIN_API_KEY?.trim());
}

async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) return;
  if (!cacheLoadPromise) {
    cacheLoadPromise = (async () => {
      try {
        const parsed = JSON.parse(await readFile(CACHE_PATH, "utf8")) as Record<string, CacheRecord>;
        cache = new Map(Object.entries(parsed).filter(([, record]) => record && typeof record.savedAt === "number" && Date.now() - record.savedAt < CACHE_TTL));
      } catch {
        cache = new Map();
      } finally {
        cacheLoaded = true;
      }
    })();
  }
  await cacheLoadPromise;
}

async function persistCache(): Promise<void> {
  const snapshot = Object.fromEntries(cache);
  persistPromise = persistPromise.then(async () => {
    await mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(snapshot), "utf8");
  }).catch(() => undefined);
  await persistPromise;
}

async function waitForRequestSlot(): Promise<void> {
  const current = requestQueue.then(async () => {
    const waitMs = Math.max(0, MIN_REQUEST_INTERVAL - (Date.now() - lastRequestAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestAt = Date.now();
  });
  requestQueue = current.catch(() => undefined);
  await current;
}

function platformFilters(platformKeys: string[], filters: GameBrainSearchFilter[] = []): string | undefined {
  const allFilters = [
    ...(platformKeys.length > 0 ? [{ key: "platform", values: platformKeys.map((value) => ({ value })), connection: "OR" as const }] : []),
    ...filters,
  ];
  return allFilters.length > 0 ? JSON.stringify(allFilters) : undefined;
}

async function requestGameBrainEndpoint<T>(url: string, cacheKey: string, quotaCost = 1): Promise<T> {
  if (!isGameBrainConfigured()) throw new GameBrainUnavailableError("??????? GAMEBRAIN_API_KEY");
  await ensureCacheLoaded();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL) {
    cacheStats.hits += 1;
    return cached.data as T;
  }
  if (quotaLeft !== null && quotaLeft < quotaCost) throw new GameBrainQuotaError();

  const active = inFlight.get(cacheKey);
  if (active) {
    cacheStats.inFlightHits += 1;
    return await active as T;
  }
  cacheStats.misses += 1;

  const request = (async (): Promise<T> => {
    await waitForRequestSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      cacheStats.networkRequests += 1;
      const response = await fetch(url, {
        headers: { "x-api-key": process.env.GAMEBRAIN_API_KEY!, "User-Agent": "WanShenMe/1.0", Accept: "application/json" },
        signal: controller.signal,
      });
      const chargedHeader = response.headers.get("x-api-quota-request");
      const charged = chargedHeader === null ? Number.NaN : Number(chargedHeader);
      cacheStats.quotaTokens += Number.isFinite(charged) ? charged : quotaCost;
      const left = Number(response.headers.get("x-api-quota-left"));
      if (Number.isFinite(left)) quotaLeft = left;
      if (response.status === 402) throw new GameBrainQuotaError();
      if (response.status === 429) throw new GameBrainUnavailableError("GameBrain ??????????");
      if (!response.ok) throw new GameBrainUnavailableError(`GameBrain API ?? ${response.status}`);
      const data = (await response.json()) as T;
      cache.set(cacheKey, { savedAt: Date.now(), data });
      void persistCache();
      return data;
    } catch (error) {
      cacheStats.failures += 1;
      if (error instanceof GameBrainUnavailableError || error instanceof GameBrainQuotaError) throw error;
      throw new GameBrainUnavailableError("GameBrain API ??????????");
    } finally {
      clearTimeout(timer);
    }
  })();

  inFlight.set(cacheKey, request as Promise<unknown>);
  try {
    return await request;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function searchPage(query: string, platformKeys: string[], offset: number, limit: number, options: GameBrainSearchOptions = {}): Promise<SearchResponse> {
  const params = new URLSearchParams({ query, offset: String(offset), limit: String(limit) });
  const filters = platformFilters(platformKeys, options.filters);
  if (filters) params.set("filters", filters);
  if (options.sort) params.set("sort", options.sort);
  if (options.sortOrder) params.set("sort-order", options.sortOrder);
  if (options.generateFilterOptions) params.set("generate-filter-options", "true");
  return requestGameBrainEndpoint<SearchResponse>(`${API_BASE}/games?${params.toString()}`, `games:${params.toString()}`);
}

const SEARCH_PAGE_SIZE = 10;
const MAX_SEARCH_PAGES = 2;

export async function searchGameBrain(
  query: string,
  platformKeys: string[],
  candidateCount: number,
  offset = 0,
  options: GameBrainSearchOptions = {}
): Promise<GameBrainGame[]> {
  const maxPages = Math.max(1, Math.min(MAX_SEARCH_PAGES, options.maxPages ?? MAX_SEARCH_PAGES));
  const target = Math.max(1, Math.min(candidateCount, SEARCH_PAGE_SIZE * maxPages));
  const minimumResults = Math.max(1, Math.min(target, options.minimumResults ?? target));
  const results: GameBrainGame[] = [];
  let nextOffset = offset;
  for (let page = 0; page < maxPages && results.length < target; page++) {
    if (options.requestBudget && options.requestBudget.remaining < 1) break;
    if (options.requestBudget) {
      options.requestBudget.remaining -= 1;
      options.requestBudget.used += 1;
    }
    const data = await searchPage(query, platformKeys, nextOffset, SEARCH_PAGE_SIZE, options);
    const pageResults = data.results ?? [];
    results.push(...pageResults);
    if (pageResults.length === 0) break;
    if (results.length >= minimumResults) break;

    // Some deployments cap the requested page size. Prefer the API's reported
    // limit/total so we can still paginate correctly without wasting a request.
    const reportedLimit = Number(data.limit);
    const step = Number.isFinite(reportedLimit) && reportedLimit > 0 ? reportedLimit : pageResults.length;
    nextOffset += step;
    const total = Number(data.total_results);
    if (Number.isFinite(total) && nextOffset >= total) break;
    // If the server reports a smaller effective page size, keep walking pages
    // even when total_results is omitted instead of prematurely truncating
    // a paginated search.
    if (pageResults.length < SEARCH_PAGE_SIZE && (!Number.isFinite(reportedLimit) || reportedLimit >= SEARCH_PAGE_SIZE)) break;
  }
  const seen = new Set<number>();
  return results.filter((game) => game.id > 0 && game.name && !seen.has(game.id) && seen.add(game.id)).slice(0, candidateCount);
}

export async function suggestGameBrain(query: string, limit = 5): Promise<GameBrainGame[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const params = new URLSearchParams({ query: trimmed, limit: String(Math.max(1, Math.min(10, limit))) });
  const data = await requestGameBrainEndpoint<{ results?: GameBrainGame[] }>(
    `${API_BASE}/games/suggestions?${params.toString()}`,
    `suggestions:${params.toString()}`,
    0.1
  );
  return (data.results ?? []).filter((game) => game.id > 0 && game.name).slice(0, limit);
}

export async function getSimilarGameBrain(gameId: number, limit = 10): Promise<GameBrainGame[]> {
  const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(limit, 10))) });
  const data = await requestGameBrainEndpoint<{ results?: GameBrainGame[] }>(
    `${API_BASE}/games/${gameId}/similar?${params.toString()}`,
    `similar:${gameId}:${params.toString()}`
  );
  return data.results ?? [];
}

export function gameBrainQuotaLeft(): number | null {
  return quotaLeft;
}
