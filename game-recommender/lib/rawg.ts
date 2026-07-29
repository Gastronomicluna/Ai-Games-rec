import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

// RAWG game database client. All requests run on the server and require RAWG_API_KEY.

const API_BASE = "https://api.rawg.io/api";
const CACHE_TTL = 30 * 60 * 1000;
const cache = new Map<string, { t: number; data: unknown }>();
let rawgIpv4Promise: Promise<string[]> | null = null;
let preferDoh = false;

class RawgHttpError extends Error {}

async function resolveRawgIpv4(): Promise<string[]> {
  if (!rawgIpv4Promise) {
    rawgIpv4Promise = (async () => {
      const providers = [
        "https://dns.google/resolve?name=api.rawg.io&type=A",
        "https://cloudflare-dns.com/dns-query?name=api.rawg.io&type=A",
      ];
      for (const provider of providers) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(provider, {
            headers: { Accept: "application/dns-json" },
            signal: controller.signal,
          });
          if (!response.ok) continue;
          const data = (await response.json()) as { Answer?: { type?: number; data?: string }[] };
          const addresses = (data.Answer ?? [])
            .filter((answer) => answer.type === 1 && typeof answer.data === "string")
            .map((answer) => answer.data as string)
            .filter((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address));
          if (addresses.length > 0) return Array.from(new Set(addresses));
        } catch {
          // Try the next DoH provider.
        } finally {
          clearTimeout(timer);
        }
      }
      throw new Error("Unable to resolve RAWG through DNS-over-HTTPS");
    })().catch((error) => {
      rawgIpv4Promise = null;
      throw error;
    });
  }
  return rawgIpv4Promise;
}

function requestJsonAtAddress<T>(url: string, address: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const parsed = new URL(url);
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family: 4 }]);
      else callback(null, address, 4);
    };
    const request = httpsRequest(
      parsed,
      {
        headers: { Accept: "application/json", "User-Agent": "WanShenMe/1.0" },
        lookup,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new RawgHttpError(`RAWG HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("RAWG fallback timeout")));
    request.on("error", reject);
    request.end();
  });
}

async function fetchJsonWithDoh<T>(url: string, timeoutMs: number): Promise<T> {
  const addresses = await resolveRawgIpv4();
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await requestJsonAtAddress<T>(url, address, timeoutMs);
    } catch (error) {
      lastError = error;
      if (error instanceof RawgHttpError) throw error;
    }
  }
  throw lastError ?? new Error("RAWG fallback connection failed");
}

async function requestRawgJson<T>(url: string, timeoutMs: number): Promise<T> {
  if (preferDoh) {
    try {
      return await fetchJsonWithDoh<T>(url, timeoutMs);
    } catch (error) {
      preferDoh = false;
      throw error;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "WanShenMe/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new RawgHttpError(`RAWG HTTP ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof RawgHttpError) throw error;
    const data = await fetchJsonWithDoh<T>(url, timeoutMs);
    preferDoh = true;
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(path: string, timeoutMs = 15000, retries = 1): Promise<T | null> {
  const apiKey = process.env.RAWG_API_KEY;
  if (!apiKey) return null;

  const separator = path.includes("?") ? "&" : "?";
  const url = `${API_BASE}${path}${separator}key=${encodeURIComponent(apiKey)}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data as T;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await requestRawgJson<T>(url, timeoutMs);
      cache.set(url, { t: Date.now(), data });
      return data;
    } catch {
      if (attempt === retries) return null;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  return null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RawgNamedItem {
  id: number;
  name: string;
  slug?: string;
}

export interface RawgPlatformEntry {
  platform: RawgNamedItem;
  released_at?: string | null;
  requirements_en?: { minimum?: string; recommended?: string } | null;
}

export interface RawgStoreEntry {
  id: number;
  store: RawgNamedItem & { domain?: string };
}

export interface RawgGameSummary {
  id: number;
  slug: string;
  name: string;
  released?: string | null;
  background_image?: string | null;
  rating?: number;
  rating_top?: number;
  ratings_count?: number;
  metacritic?: number | null;
  playtime?: number;
  platforms?: RawgPlatformEntry[] | null;
  genres?: RawgNamedItem[];
  tags?: (RawgNamedItem & { language?: string; games_count?: number })[];
  stores?: RawgStoreEntry[] | null;
}

export interface RawgGameDetail extends RawgGameSummary {
  description_raw?: string;
  developers?: RawgNamedItem[];
  publishers?: RawgNamedItem[];
  website?: string;
}

export interface RawgStoreLink {
  id: number;
  game_id: number;
  store_id: number;
  url: string;
}

interface RawgListResponse<T> {
  count: number;
  next?: string | null;
  previous?: string | null;
  results: T[];
}

export function isRawgConfigured(): boolean {
  return Boolean(process.env.RAWG_API_KEY?.trim());
}

export async function searchRawg(query: string, count = 3): Promise<RawgGameSummary[]> {
  const params = new URLSearchParams({
    search: query,
    page_size: String(count),
    search_precise: "true",
    exclude_additions: "true",
  });
  const data = await fetchJson<RawgListResponse<RawgGameSummary>>(`/games?${params.toString()}`);
  return data?.results ?? [];
}

export async function getRawgGame(id: number): Promise<RawgGameDetail | null> {
  return fetchJson<RawgGameDetail>(`/games/${id}`);
}

export async function getRawgGamesBatch(ids: number[]): Promise<Map<number, RawgGameDetail>> {
  const result = new Map<number, RawgGameDetail>();
  await mapLimit(ids, 6, async (id) => {
    const game = await getRawgGame(id);
    if (game) result.set(id, game);
  });
  return result;
}

export async function getRawgStoreLinks(id: number): Promise<RawgStoreLink[]> {
  const data = await fetchJson<RawgListResponse<RawgStoreLink>>(`/games/${id}/stores`);
  return data?.results ?? [];
}

export async function getRawgStoreLinksBatch(ids: number[]): Promise<Map<number, RawgStoreLink[]>> {
  const result = new Map<number, RawgStoreLink[]>();
  await mapLimit(ids, 6, async (id) => {
    result.set(id, await getRawgStoreLinks(id));
  });
  return result;
}

export function rawgPlatformNames(game: RawgGameSummary): string[] {
  return Array.from(
    new Set((game.platforms ?? []).map((entry) => entry.platform.name).filter(Boolean))
  );
}

export function rawgHasSteam(game: RawgGameSummary): boolean {
  return (game.stores ?? []).some((entry) => entry.store.id === 1 || entry.store.slug === "steam");
}

export function inferRawgPlayerModes(game: RawgGameSummary): string[] {
  const values = [...(game.tags ?? []), ...(game.genres ?? [])].map((item) =>
    `${item.slug ?? ""} ${item.name}`.toLowerCase()
  );
  const includes = (...terms: string[]) => values.some((value) => terms.some((term) => value.includes(term)));
  const modes: string[] = [];
  if (includes("singleplayer", "single-player", "single player")) modes.push("单人");
  if (includes("multiplayer", "multi-player", "multi player")) modes.push("多人");
  if (includes("co-op", "coop", "cooperative")) modes.push("合作");
  if (includes("online co-op", "online coop")) modes.push("在线合作");
  if (includes("local co-op", "local coop", "split screen", "split-screen")) modes.push("本地/同屏合作");
  return modes;
}

