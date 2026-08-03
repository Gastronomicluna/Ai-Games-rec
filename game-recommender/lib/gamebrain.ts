import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://api.gamebrain.co/v1";
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
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
}

interface SearchResponse {
  total_results?: number;
  limit?: number;
  offset?: number;
  results?: GameBrainGame[];
}

interface CacheRecord {
  savedAt: number;
  data: SearchResponse;
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
let cache = new Map<string, CacheRecord>();
let quotaLeft: number | null = null;
let persistPromise = Promise.resolve();

export function isGameBrainConfigured(): boolean {
  return Boolean(process.env.GAMEBRAIN_API_KEY?.trim());
}

async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(CACHE_PATH, "utf8")) as Record<string, CacheRecord>;
    cache = new Map(Object.entries(parsed).filter(([, record]) => Date.now() - record.savedAt < CACHE_TTL));
  } catch {
    cache = new Map();
  }
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

function platformFilters(platformKeys: string[]): string | undefined {
  if (platformKeys.length === 0) return undefined;
  return JSON.stringify([{ key: "platform", values: platformKeys.map((value) => ({ value })), connection: "OR" }]);
}

async function requestGameBrainEndpoint<T>(url: string, cacheKey: string): Promise<T> {
  if (!isGameBrainConfigured()) throw new GameBrainUnavailableError("服务端尚未配置 GAMEBRAIN_API_KEY");
  await ensureCacheLoaded();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL) return cached.data as T;
  if (quotaLeft !== null && quotaLeft < 1) throw new GameBrainQuotaError();

  await waitForRequestSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { "x-api-key": process.env.GAMEBRAIN_API_KEY!, "User-Agent": "WanShenMe/1.0", Accept: "application/json" },
      signal: controller.signal,
    });
    const left = Number(response.headers.get("x-api-quota-left"));
    if (Number.isFinite(left)) quotaLeft = left;
    if (response.status === 402) throw new GameBrainQuotaError();
    if (response.status === 429) throw new GameBrainUnavailableError("GameBrain 请求过快，请稍后重试");
    if (!response.ok) throw new GameBrainUnavailableError(`GameBrain API 错误 ${response.status}`);
    const data = (await response.json()) as T;
    cache.set(cacheKey, { savedAt: Date.now(), data: data as SearchResponse });
    void persistCache();
    return data;
  } catch (error) {
    if (error instanceof GameBrainUnavailableError || error instanceof GameBrainQuotaError) throw error;
    throw new GameBrainUnavailableError("GameBrain API 请求超时或网络不可用");
  } finally {
    clearTimeout(timer);
  }
}

async function searchPage(query: string, platformKeys: string[], offset: number, limit: number): Promise<SearchResponse> {
  const params = new URLSearchParams({ query, offset: String(offset), limit: String(limit) });
  const filters = platformFilters(platformKeys);
  if (filters) params.set("filters", filters);
  return requestGameBrainEndpoint<SearchResponse>(`${API_BASE}/games?${params.toString()}`, `games:${params.toString()}`);
}

export async function searchGameBrain(
  query: string,
  platformKeys: string[],
  candidateCount: number,
  offset = 0
): Promise<GameBrainGame[]> {
  const pages = Math.max(1, Math.min(4, Math.ceil(candidateCount / 10)));
  const results: GameBrainGame[] = [];
  for (let page = 0; page < pages; page++) {
    const data = await searchPage(query, platformKeys, offset + page * 10, 10);
    results.push(...(data.results ?? []));
    if ((data.results ?? []).length < 10) break;
  }
  const seen = new Set<number>();
  return results.filter((game) => game.id > 0 && game.name && !seen.has(game.id) && seen.add(game.id)).slice(0, candidateCount);
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
