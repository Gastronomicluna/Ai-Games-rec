import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { suggestGameBrain, type GameBrainGame } from "./gamebrain";
import { searchWikidataBatch, type WikidataGame } from "./wikidata";
import { derivePlayerModes, getAppDataBatch, searchStore, type SteamAppData } from "./steam";

export interface ReferenceGameProfile {
  requestedName: string;
  matchedName: string;
  genres: string[];
  playerModes: string[];
  tags: string[];
  visualStyle: string[];
  gameplay: string[];
  platforms: string[];
  releaseDate: string | null;
  sources: string[];
}

interface ProfileCacheEntry {
  savedAt: number;
  profiles: ReferenceGameProfile[];
}

const PROFILE_CACHE_TTL = Number(process.env.REFERENCE_PROFILE_CACHE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
const PROFILE_CACHE_PATH = process.env.REFERENCE_PROFILE_CACHE_PATH || path.join(process.cwd(), ".cache", "reference-profiles.json");
const MAX_PROFILE_CACHE_ENTRIES = 1000;
const profileCache = new Map<string, ProfileCacheEntry>();
const profileInFlight = new Map<string, Promise<ReferenceGameProfile[]>>();
let profileCacheLoaded = false;
let profileLoadPromise: Promise<void> | null = null;
let profilePersistPromise = Promise.resolve();

async function ensureProfileCacheLoaded(): Promise<void> {
  if (profileCacheLoaded) return;
  if (!profileLoadPromise) {
    profileLoadPromise = (async () => {
      try {
        const parsed = JSON.parse(await readFile(PROFILE_CACHE_PATH, "utf8")) as Record<string, ProfileCacheEntry>;
        const now = Date.now();
        for (const [key, entry] of Object.entries(parsed)) {
          if (!entry || typeof entry.savedAt !== "number" || !Array.isArray(entry.profiles) || now - entry.savedAt >= PROFILE_CACHE_TTL) continue;
          profileCache.set(key, entry);
        }
      } catch {
        profileCache.clear();
      } finally {
        profileCacheLoaded = true;
      }
    })();
  }
  await profileLoadPromise;
}

function cacheProfiles(key: string, profiles: ReferenceGameProfile[]): void {
  profileCache.set(key, { savedAt: Date.now(), profiles });
  while (profileCache.size > MAX_PROFILE_CACHE_ENTRIES) {
    const oldest = profileCache.keys().next().value;
    if (typeof oldest !== "string") break;
    profileCache.delete(oldest);
  }
  const snapshot = Object.fromEntries(profileCache);
  profilePersistPromise = profilePersistPromise.then(async () => {
    await mkdir(path.dirname(PROFILE_CACHE_PATH), { recursive: true });
    await writeFile(PROFILE_CACHE_PATH, JSON.stringify(snapshot), "utf8");
  }).catch(() => undefined);
  void profilePersistPromise;
}

function normalizeName(name: string): string {
  return name.normalize("NFKD").toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function isNameMatch(target: string, candidate: string): boolean {
  const a = normalizeName(target);
  const b = normalizeName(candidate);
  return Boolean(a && b && (a === b || (a.length >= 5 && b.includes(a)) || (b.length >= 5 && a.includes(b))));
}

function gameBrainProfile(requestedName: string, game: GameBrainGame | undefined): ReferenceGameProfile | null {
  if (!game) return null;
  const genres = game.genre ? game.genre.split(/[,/]/).map((value) => value.trim()).filter(Boolean) : [];
  return {
    requestedName,
    matchedName: game.name,
    genres,
    playerModes: [],
    tags: genres,
    visualStyle: [],
    gameplay: [],
    platforms: [],
    releaseDate: game.year ? `${game.year}-01-01` : null,
    sources: ["GameBrain"],
  };
}

function steamProfile(requestedName: string, result: { name: string; app: SteamAppData } | null): ReferenceGameProfile | null {
  if (!result) return null;
  const app = result.app;
  const genres = (app.genres ?? []).map((item) => item.description).filter(Boolean);
  const playerModes = derivePlayerModes(app);
  const tags = Array.from(new Set([...genres, ...playerModes, ...(app.categories ?? []).map((item) => item.description).filter(Boolean)])).slice(0, 12);
  const platforms = [app.platforms?.windows ? "Windows / Steam" : "", app.platforms?.mac ? "macOS" : "", app.platforms?.linux ? "Linux" : ""].filter(Boolean);
  return {
    requestedName,
    matchedName: result.name,
    genres,
    playerModes,
    tags,
    visualStyle: [],
    gameplay: [],
    platforms,
    releaseDate: app.release_date?.date ?? null,
    sources: ["Steam"],
  };
}

function wikidataProfile(requestedName: string, game: WikidataGame | undefined): ReferenceGameProfile | null {
  if (!game) return null;
  return {
    requestedName,
    matchedName: game.name,
    genres: game.genres.slice(0, 8),
    playerModes: game.gameModes.slice(0, 8),
    tags: Array.from(new Set([...game.genres, ...game.gameModes])).slice(0, 12),
    visualStyle: [],
    gameplay: [],
    platforms: game.platforms.slice(0, 8),
    releaseDate: game.releaseDate ?? null,
    sources: ["Wikidata"],
  };
}

function mergeProfiles(primary: ReferenceGameProfile, secondary: ReferenceGameProfile | null): ReferenceGameProfile {
  if (!secondary) return primary;
  return {
    requestedName: primary.requestedName,
    matchedName: primary.matchedName || secondary.matchedName,
    genres: Array.from(new Set([...primary.genres, ...secondary.genres])).slice(0, 10),
    playerModes: Array.from(new Set([...primary.playerModes, ...secondary.playerModes])).slice(0, 10),
    tags: Array.from(new Set([...primary.tags, ...secondary.tags])).slice(0, 16),
    visualStyle: Array.from(new Set([...(primary.visualStyle ?? []), ...(secondary.visualStyle ?? [])])).slice(0, 12),
    gameplay: Array.from(new Set([...(primary.gameplay ?? []), ...(secondary.gameplay ?? [])])).slice(0, 12),
    platforms: Array.from(new Set([...primary.platforms, ...secondary.platforms])).slice(0, 10),
    releaseDate: primary.releaseDate ?? secondary.releaseDate,
    sources: Array.from(new Set([...primary.sources, ...secondary.sources])),
  };
}

async function resolveReferenceGames(names: string[], includeSteam: boolean): Promise<ReferenceGameProfile[]> {
  const requested = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 6);
  if (requested.length === 0) return [];

  const [steamSearches, wikidataResults, gameBrainSuggestions] = await Promise.all([
    includeSteam ? Promise.all(requested.map((name) => searchStore(name, 5))) : Promise.resolve(requested.map(() => [])),
    searchWikidataBatch(requested.map((query) => ({ query, limit: 2 }))).catch(() => requested.map(() => [] as WikidataGame[])),
    Promise.all(requested.map((name) => suggestGameBrain(name, 5).catch(() => []))),
  ]);
  const steamMatches = requested.map((name, index) => {
    const match = steamSearches[index]?.find((item) => isNameMatch(name, item.name));
    return match ? { requestedName: name, id: match.id, name: match.name } : null;
  });
  const details = await getAppDataBatch(steamMatches.filter((item): item is { requestedName: string; id: number; name: string } => Boolean(item)).map((item) => item.id));

  return requested.map((name, index) => {
    const steamMatch = steamMatches[index];
    const steamApp = steamMatch ? details.get(steamMatch.id) : undefined;
    const steam = steamMatch && steamApp ? steamProfile(name, { name: steamMatch.name, app: steamApp }) : null;
    const wikiGames = wikidataResults[index] ?? [];
    const wiki = wikidataProfile(name, wikiGames.find((game) => isNameMatch(name, game.name)) ?? wikiGames[0]);
    const gameBrain = gameBrainProfile(name, gameBrainSuggestions[index]?.find((game) => isNameMatch(name, game.name)) ?? gameBrainSuggestions[index]?.[0]);
    if (steam) return mergeProfiles(mergeProfiles(steam, gameBrain), wiki);
    if (gameBrain) return mergeProfiles(gameBrain, wiki);
    return wiki ?? {
      requestedName: name,
      matchedName: name,
      genres: [],
      playerModes: [],
      tags: [],
      visualStyle: [],
      gameplay: [],
      platforms: [],
      releaseDate: null,
      sources: [],
    };
  });
}

export async function analyzeReferenceGames(names: string[], options: { includeSteam?: boolean } = {}): Promise<ReferenceGameProfile[]> {
  const requested = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 6);
  if (requested.length === 0) return [];
  const includeSteam = options.includeSteam !== false;
  const cacheKey = `v2:${includeSteam ? "steam" : "catalog"}:${requested.map((name) => normalizeName(name)).join("|")}`;
  await ensureProfileCacheLoaded();
  const cached = profileCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < PROFILE_CACHE_TTL) return cached.profiles;

  const active = profileInFlight.get(cacheKey);
  if (active) return await active;
  const request = resolveReferenceGames(requested, includeSteam);
  profileInFlight.set(cacheKey, request);
  try {
    const profiles = await request;
    if (profiles.some((profile) => profile.sources.length > 0)) cacheProfiles(cacheKey, profiles);
    return profiles;
  } finally {
    profileInFlight.delete(cacheKey);
  }
}

export function summarizeReferenceProfiles(profiles: ReferenceGameProfile[]): {
  genres: string[];
  playerModes: string[];
  tags: string[];
  visualStyle: string[];
  gameplay: string[];
  platforms: string[];
} {
  return {
    genres: Array.from(new Set(profiles.flatMap((profile) => profile.genres))).slice(0, 12),
    playerModes: Array.from(new Set(profiles.flatMap((profile) => profile.playerModes))).slice(0, 12),
    tags: Array.from(new Set(profiles.flatMap((profile) => profile.tags))).slice(0, 18),
    visualStyle: Array.from(new Set(profiles.flatMap((profile) => profile.visualStyle ?? []))).slice(0, 12),
    gameplay: Array.from(new Set(profiles.flatMap((profile) => profile.gameplay ?? []))).slice(0, 12),
    platforms: Array.from(new Set(profiles.flatMap((profile) => profile.platforms))).slice(0, 12),
  };
}
