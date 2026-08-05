// Recommendation pipeline: search planning -> verified Wikidata/Steam candidates -> AI ranking -> enriched result data.

import { aiUsageStats, chatCompletionJson, diffAiUsage } from "./ai";
import { getCachedLlmResult, llmCacheStats } from "./llm-cache";
import { gameBrainCacheStats, getSimilarGameBrain, searchGameBrain, suggestGameBrain, isGameBrainConfigured, type GameBrainGame, GameBrainQuotaError, GameBrainUnavailableError } from "./gamebrain";
import { matchesPlatformFilter, platformPreferenceText, releaseFilterText, searchPlanKey, transcript, matchesReleaseFilter } from "./recommend-preferences";
import { analyzeReferenceGames, summarizeReferenceProfiles, type ReferenceGameProfile } from "./game-knowledge";
import { matchesReleaseConstraint, normalizeGameTitle, parseRecommendationIntent, releaseConstraintText, type RecommendationIntent } from "./recommend-intent";
import {
  getWikipediaEnrichment,
  searchWikidataBatch,
  wikidataPageUrl,
  type WikidataGame,
  type WikipediaEnrichment,
  wikidataCacheStats,
} from "./wikidata";
import {
  derivePlayerModes,
  getAppDataBatch,
  getReviewSummaries,
  parseReleaseTimestamp,
  reviewLabel,
  searchStore,
  type ReviewSummary,
  steamCacheStats,
  type SteamAppData,
} from "./steam";
import type { AgentTraceEvent, ChatMessage, Game, Platform, PreviousRecommendation, RecommendResponse, ReleaseFilter } from "./types";

const WIKIDATA_CANDIDATE_CAP = 60;
const STEAM_CANDIDATE_CAP = 60;
const RANK_POOL_CAP = 60;
const SEARCH_PLAN_CACHE_TTL = 15 * 60 * 1000;
const searchPlanCache = new Map<string, { t: number; plan: SearchPlan }>();

const RECOMMEND_QUALITY = process.env.RECOMMEND_QUALITY === "balanced" ? "balanced" : "deep";
const ENTITY_MAX_TOKENS = RECOMMEND_QUALITY === "deep" ? 1200 : 500;
const AGENT_MAX_TOKENS = RECOMMEND_QUALITY === "deep" ? 4200 : 1800;
const RANK_MAX_TOKENS = RECOMMEND_QUALITY === "deep" ? 8000 : 4000;
const RANK_MIN_TOKENS = RECOMMEND_QUALITY === "deep" ? 4000 : 1600;
const REVIEW_MAX_TOKENS = RECOMMEND_QUALITY === "deep" ? 3200 : 0;
const MAX_AGENT_TURNS = Math.max(2, Math.min(5, Number(process.env.RECOMMEND_MAX_AGENT_TURNS ?? (RECOMMEND_QUALITY === "deep" ? 4 : 3)) || 3));

type ProgressReporter = (event: Omit<AgentTraceEvent, "id" | "timestamp">) => void;

function reportProgress(onProgress: ProgressReporter | undefined, stage: AgentTraceEvent["stage"], title: string, detail: string): void {
  onProgress?.({ stage, title, detail });
}

interface SearchPlan {
  query: string;
  titles: string[];
  keywords: string[];
}

interface Candidate {
  key: string;
  id: number;
  name: string;
  gamebrain: GameBrainGame | null;
  wikidata: WikidataGame | null;
  steamId: number | null;
  steam: SteamAppData | null;
  matchedPlatformNames: string[];
  similarToReference: boolean;
}

function metricDelta<T extends object>(before: T, after: T): Record<string, number> {
  const beforeValues = before as Record<string, number>;
  const afterValues = after as Record<string, number>;
  return Object.fromEntries(Object.keys(afterValues).map((key) => [key, (afterValues[key] ?? 0) - (beforeValues[key] ?? 0)]));
}

function uniqueTerms(values: unknown[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const term = value.trim();
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    result.push(term);
    if (result.length >= limit) break;
  }
  return result;
}

function shouldMatchSteam(messages: ChatMessage[], platforms?: Platform[]): boolean {
  if (platforms && platforms.length > 0) return platforms.includes("steam");
  const userText = messages.filter((message) => message.role === "user").map((message) => message.content).join(" ");
  return !/(nintendo|switch|playstation|\bps[345]\b|xbox|主机独占|手游|手机游戏|android|ios)/i.test(userText);
}

function mergeUniqueNames(...groups: string[][]): string[] {
  return uniqueTerms(groups.flat(), 8);
}

async function enrichRecommendationIntent(intent: RecommendationIntent, messages: ChatMessage[]): Promise<RecommendationIntent> {
  const rawText = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
  const context = { rawText, existingReferences: intent.referenceGames, existingCompanies: intent.companies };
  try {
    const cached = await getCachedLlmResult("intent-entities", context, 60 * 60 * 1000, () => chatCompletionJson<{ references?: unknown[]; companies?: unknown[] }>([
      {
        role: "system",
        content: `Extract explicit game and company entities from a game recommendation request.
- references: game titles that the user likes, mentions, or asks to use as a reference.
- companies: requested developer, publisher, studio, or platform-holder names. Use a canonical English name when known.
- Do not infer a company unless the user explicitly asks for it.
Return JSON only: {"references":["..."],"companies":["..."]}`,
      },
      { role: "user", content: JSON.stringify(context) },
    ], { maxTokens: ENTITY_MAX_TOKENS, temperature: 0, model: process.env.AI_FAST_MODEL }));
    const references = mergeUniqueNames(intent.referenceGames, uniqueTerms(cached.value.references ?? [], 6));
    const companies = mergeUniqueNames(intent.companies, uniqueTerms(cached.value.companies ?? [], 6));
    return { ...intent, referenceGames: references, companies };
  } catch (error) {
    console.warn("[intent] entity enrichment fallback:", error instanceof Error ? error.message : error);
    return intent;
  }
}

function releaseHintForFilter(filter: ReleaseFilter): string {
  const currentYear = new Date().getFullYear();
  if (filter === "recent" || filter === "last5") return ` released ${currentYear - 4} or newer`;
  if (filter === "classic" || filter === "before2020") return " released before 2020";
  if (filter === "last1") return ` released ${currentYear} or newer`;
  if (filter === "last3") return ` released ${currentYear - 2} or newer`;
  if (filter === "before2010") return " released before 2010";
  return "";
}

async function buildSearchPlan(messages: ChatMessage[], platforms: Platform[], previousGames: PreviousRecommendation[], releaseFilter: ReleaseFilter): Promise<SearchPlan> {
  const cacheKey = `${searchPlanKey(messages, platforms)}\nrelease:${releaseFilter}\nprevious:${previousGames.map((game) => `${game.id}:${game.name}`).join("|")}`;
  const cached = searchPlanCache.get(cacheKey);
  if (cached && Date.now() - cached.t < SEARCH_PLAN_CACHE_TTL) return cached.plan;

  const system = `You plan searches for a Chinese game recommendation product backed by Wikidata, Wikipedia, and Steam. Read the full conversation and propose real games likely to satisfy the user. Every title is verified through a real data source before recommendation, so never invent games.
Requirements:
- query: one compact English search phrase, 5-15 words, containing reference game names and desired traits; do not write a sentence and do not use the phrase "similar to"
- titles: 8-10 specific standalone full games for fallback only, using their official English names whenever possible
- Prefer precise titles such as "It Takes Two" or "Portal 2", not abstract genre phrases
- Do not include demos, playtests, soundtracks, friend passes, dedicated servers, DLC, or companion apps
- Include multiple platforms when the user did not explicitly select a platform
- When release preference is unrestricted, balance relevance with freshness: include several games from the last 5 years when compatible instead of returning only famous older games
- Treat games explicitly marked as favorites as the strongest taste signal
- Do not recommend a favorite game itself; recommend alternatives sharing the most relevant traits
- The selected platform preference is a hard availability constraint when specified
- keywords: 3-5 short English genre, theme, or mechanic phrases for fallback search
- Output JSON only: {"query":"Hades beginner friendly action roguelike","titles":["..."],"keywords":["..."]}`;

  let parsed: { query?: unknown; titles?: unknown[]; keywords?: unknown[] };
  try {
    parsed = await chatCompletionJson<{ query?: unknown; titles?: unknown[]; keywords?: unknown[] }>(
      [
        { role: "system", content: system },
        { role: "user", content: `Selected platforms: ${platformPreferenceText(platforms)}\nRelease preference: ${releaseFilterText(releaseFilter)}\n\nConversation:\n${transcript(messages)}\n\nPreviously recommended games (use these to understand what to revise or avoid):\n${JSON.stringify(previousGames)}` },
      ],
      { maxTokens: 4000, temperature: 0.3, model: process.env.AI_FAST_MODEL }
    );
  } catch (error) {
    console.warn("[recommend] search plan fallback:", error instanceof Error ? error.message : error);
    const latestUser = messages.filter((message) => message.role === "user").at(-1)?.content ?? "game recommendations";
    const fallbackQuery = latestUser
      .replace(/我喜欢|请推荐|推荐|游戏|只要|平台|最近一年|近1年|近3年|近5年|2020年前|2010年前/g, " ")
      .replace(/射击/g, " shooter ")
      .replace(/动作/g, " action ")
      .replace(/角色扮演|RPG/gi, " role playing ")
      .replace(/单人/g, " single player ")
      .replace(/多人|联机/g, " multiplayer ")
      .replace(/合作/g, " co-op ")
      .replace(/回合制/g, " turn based ")
      .replace(/现代/g, " modern ")
      .replace(/战斗/g, " combat ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "video games";
    const releaseHint = releaseHintForFilter(releaseFilter);
    return { query: fallbackQuery + releaseHint, titles: [], keywords: [] };
  }
  const query = typeof parsed.query === "string" && parsed.query.trim() ? parsed.query.trim().slice(0, 180) : uniqueTerms(parsed.titles ?? [], 3).join(" ");
  const titles = uniqueTerms(parsed.titles ?? [], 10);
  const keywords = uniqueTerms(parsed.keywords ?? [], 5);
  searchPlanCache.set(cacheKey, { t: Date.now(), plan: { query, titles, keywords } });
  return { query, titles, keywords };
}

function isLikelyStandaloneName(name: string): boolean {
  return !/(friend[?'s]* pass|demo|playtest|soundtrack|dedicated server|benchmark|artbook|companion|editor|test server|\bdlc\b|season pass)/i.test(name);
}

function isLikelyStandaloneSteamGame(app: SteamAppData): boolean {
  return app.type === "game" && Boolean(app.name && app.header_image) && isLikelyStandaloneName(app.name ?? "");
}

function normalizeGameName(name: string): string {
  return normalizeGameTitle(name);
}

function pickSteamSearchMatch(name: string, results: { id: number; name: string }[]): number | null {
  const target = normalizeGameName(name);
  if (!target) return null;
  const match = results.find((result) => {
    const candidate = normalizeGameName(result.name);
    return candidate === target || (target.length >= 8 && candidate.includes(target)) || (candidate.length >= 8 && target.includes(candidate));
  });
  return match?.id ?? null;
}

function steamReleaseYear(app: SteamAppData | undefined): number | null {
  const value = app?.release_date?.date;
  const match = value?.match(/(\d{4})/);
  return match ? Number(match[1]) : null;
}

function selectVerifiedSteamMatch(
  name: string,
  results: { id: number; name: string }[],
  details: Map<number, SteamAppData>,
  expectedYear?: number,
  expectedCompanies: string[] = []
): number | null {
  const target = normalizeGameName(name);
  if (!target) return null;
  let best: { id: number; score: number } | null = null;
  for (const result of results) {
    const app = details.get(result.id);
    if (!app || !isLikelyStandaloneSteamGame(app)) continue;
    const candidateName = normalizeGameName(app.name ?? result.name);
    if (!candidateName) continue;
    // A partial title is unsafe for store links (for example, a fan game can
    // append a subtitle to the same name). Only exact normalized titles may
    // inherit a Steam app id; otherwise we keep the verified GameBrain/Wikidata link.
    if (candidateName !== target) continue;
    let score = 100;
    if (expectedYear) {
      const year = steamReleaseYear(app);
      if (year) {
        const delta = Math.abs(year - expectedYear);
        score += delta === 0 ? 45 : delta <= 1 ? 25 : delta <= 3 ? 5 : -35;
      }
    }
    if (expectedCompanies.length > 0) {
      const companies = [...(app.developers ?? []), ...(app.publishers ?? [])].map(normalizeCompanyName);
      const matchesCompany = expectedCompanies.every((company) => companies.some((value) => value.includes(normalizeCompanyName(company))));
      score += matchesCompany ? 50 : -50;
    }
    if (!best || score > best.score) best = { id: result.id, score };
  }
  return best && best.score >= 40 ? best.id : null;
}

function addUniqueId(ids: number[], seen: Set<number>, excluded: Set<number>, id: number, cap: number) {
  if (ids.length >= cap || seen.has(id) || excluded.has(id)) return;
  seen.add(id);
  ids.push(id);
}

function balanceReleaseOrder(games: GameBrainGame[], releaseFilter: ReleaseFilter): GameBrainGame[] {
  if (releaseFilter !== "all") return games;
  const currentYear = new Date().getFullYear();
  const recent = games.filter((game) => typeof game.year === "number" && game.year >= currentYear - 5);
  const other = games.filter((game) => !recent.includes(game));
  if (recent.length === 0 || other.length === 0) return games;

  // Keep relevance order inside each bucket, but expose recent games early
  // enough for the ranking model to consider them instead of only seeing the
  // catalog's older/popular first page.
  const balanced: GameBrainGame[] = [];
  let recentIndex = 0;
  let otherIndex = 0;
  while (recentIndex < recent.length || otherIndex < other.length) {
    for (let i = 0; i < 2 && recentIndex < recent.length; i++) balanced.push(recent[recentIndex++]);
    if (otherIndex < other.length) balanced.push(other[otherIndex++]);
  }
  return balanced;
}

const GAMEBRAIN_PLATFORM_KEYS: Record<Platform, string[]> = {
  steam: ["pc"],
  psn: ["playstation_4", "playstation_5"],
  ns: ["nintendo_switch"],
};

const PLATFORM_DISPLAY_NAMES: Record<Platform, string> = {
  steam: "Windows / Steam",
  psn: "PlayStation",
  ns: "Nintendo Switch",
};

function franchiseQuery(name: string): string | null {
  const base = name
    .replace(/\s*(?:\d+|[ivxlcdm]+|[\u4e00-\u9fff]\s*\d+)$/i, "")
    .replace(/\s*[:-].*$/, "")
    .trim();
  return base && normalizeGameName(base) !== normalizeGameName(name) ? base : null;
}

function referenceGameNames(messages: ChatMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const match of message.content.matchAll(/[\u201c\u300c\u300a\u3010]([^\u201d\u300d\u300b\u3011]{1,80})[\u201d\u300d\u300b\u3011]/g)) {
      const name = match[1].trim();
      if (name && !names.some((value) => value.toLocaleLowerCase() === name.toLocaleLowerCase())) names.push(name);
    }
  }
  return names.slice(0, 2);
}

async function gatherGameBrainCandidates(
  plan: SearchPlan,
  excludeIds: number[],
  platforms: Platform[],
  count: number,
  messages: ChatMessage[],
  releaseFilter: ReleaseFilter,
  intent?: RecommendationIntent,
  strategy: AgentSearchStrategy = "catalog",
  actionReferences: string[] = []
): Promise<Candidate[]> {
  const target = Math.min(60, Math.max(count + 20, count * 3));
  const platformKeys = Array.from(new Set(platforms.flatMap((platform) => GAMEBRAIN_PLATFORM_KEYS[platform])));
  const lookupReferences = actionReferences.length > 0
    ? actionReferences.slice(0, 2)
    : intent?.referenceGames.length ? intent.referenceGames.slice(0, 2) : referenceGameNames(messages);
  const references = strategy === "similar" ? lookupReferences : [];
  const referenceKeys = new Set(references.map((name) => normalizeGameName(name)).filter(Boolean));
  const releaseHint = intent && (intent.release.from || intent.release.to)
    ? ` ${releaseConstraintText(intent.release)}`
    : releaseHintForFilter(releaseFilter);
  const naturalQuery = (plan.query.replace(/Nintendo Switch|PlayStation|Steam|Windows|PC/gi, " ").replace(/\s+/g, " ").trim() + releaseHint).trim();
  const baseQueries = references.length > 0
    ? [references.join(" "), ...(naturalQuery && normalizeGameName(naturalQuery) !== normalizeGameName(references.join(" ")) ? [naturalQuery] : [])]
    : [naturalQuery || plan.query];
  // Similar Games can be empty for a recently released sequel. When freshness
  // matters, explicitly search the reference franchise sorted by release date.
  const franchiseQueries = strategy === "franchise" || intent?.recencyPreference === "prefer_newest"
    ? lookupReferences.map(franchiseQuery).filter((query): query is string => Boolean(query))
    : [];
  const queries = uniqueTerms([...baseQueries, ...franchiseQueries], 3);
  const branchTarget = Math.min(20, Math.ceil(target / queries.length) + 5);
  const currentYear = new Date().getFullYear();
  const releaseFilterValues = strategy === "newest" || intent?.recencyPreference === "prefer_newest"
    ? [{ key: "release_date", values: [{ value: "last_5_years" }], connection: "OR" as const }]
    : intent?.release.from && Number(intent.release.from.slice(0, 4)) >= currentYear - 1
      ? [{ key: "release_date", values: [{ value: "last_year" }], connection: "OR" as const }]
      : intent?.release.from && Number(intent.release.from.slice(0, 4)) >= currentYear - 5
        ? [{ key: "release_date", values: [{ value: "last_5_years" }], connection: "OR" as const }]
        : [];
  const searchOptions = strategy === "newest" || intent?.recencyPreference === "prefer_newest" || intent?.release.from
    ? { filters: releaseFilterValues, sort: "release_date" as const, sortOrder: "desc" as const }
    : intent?.release.to
      ? { sort: "release_date" as const, sortOrder: "asc" as const }
      : {};
  const games: GameBrainGame[] = [];
  const similarIds = new Set<number>();
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const branchGames = await searchGameBrain(queries[queryIndex], platformKeys, branchTarget, 0, searchOptions);
    games.push(...branchGames);
  }

  if (lookupReferences.length > 0) {
    const suggestionSets = await Promise.all(lookupReferences.map((reference) => suggestGameBrain(reference, 5).catch(() => [])));
    const resolved = suggestionSets
      .map((set, index) => set.find((game) => normalizeGameName(game.name) === normalizeGameName(lookupReferences[index])) ?? set[0])
      .filter((game): game is GameBrainGame => Boolean(game));

    if (intent?.mode === "exact_lookup") {
      games.push(...resolved);
    }

    if (strategy === "similar") {
      const similarSets = await Promise.all(resolved.map((seed) => getSimilarGameBrain(seed.id, 10).catch((error) => {
        if (!(error instanceof GameBrainUnavailableError || error instanceof GameBrainQuotaError)) throw error;
        console.warn("[recommend] Similar Games fallback:", error instanceof Error ? error.message : error);
        return [];
      })));
      for (const set of similarSets) {
        for (const similar of set) {
          similarIds.add(similar.id);
          games.push(similar);
        }
      }
    }
  }
  const uniqueGames = new Map<number, GameBrainGame>();
  for (const game of games) if (!uniqueGames.has(game.id)) uniqueGames.set(game.id, game);
  const mergedGames = balanceReleaseOrder(
    Array.from(uniqueGames.values()).sort((a, b) => Number(similarIds.has(b.id)) - Number(similarIds.has(a.id))),
    releaseFilter
  );
  const excluded = new Set(excludeIds);
  const filtered = mergedGames.filter((game) => !excluded.has(game.id) && isLikelyStandaloneName(game.name) && matchesReleaseFilter(game.year, releaseFilter) && !referenceKeys.has(normalizeGameName(game.name)));
  const shouldVerifySteam = platforms.length === 0 || platforms.includes("steam") || Boolean(intent?.companies.length);
  const steamSearches = shouldVerifySteam
    ? await Promise.all(filtered.map((game) => searchStore(game.name, 3)))
    : filtered.map(() => []);
  const steamDetails = await getAppDataBatch(Array.from(new Set(steamSearches.flatMap((results) => results.map((result) => result.id)))));
  const matchedPlatformNames = platforms.map((platform) => PLATFORM_DISPLAY_NAMES[platform]);

  return filtered
    .map((game, index): Candidate => {
      const possibleSteamId = selectVerifiedSteamMatch(game.name, steamSearches[index] ?? [], steamDetails, game.year, intent?.companies ?? []);
      const steam = possibleSteamId ? steamDetails.get(possibleSteamId) ?? null : null;
      const validSteam = steam && isLikelyStandaloneSteamGame(steam) ? steam : null;
      return {
        key: `gamebrain:${game.id}`,
        id: game.id,
        name: game.name,
        gamebrain: game,
        wikidata: null,
        steamId: validSteam ? possibleSteamId : null,
        steam: validSteam,
        matchedPlatformNames,
        similarToReference: similarIds.has(game.id),
      };
    })
    .filter((candidate) => matchesCompanyConstraint(candidate, intent?.companies ?? []))
    .filter((candidate) => !platforms.includes("steam") || candidate.steamId !== null || platforms.length > 1);
}

async function gatherWikidataCandidates(
  plan: SearchPlan,
  excludeIds: number[],
  includeSteam: boolean,
  platforms: Platform[],
  cap = WIKIDATA_CANDIDATE_CAP,
  releaseFilter: ReleaseFilter = "all"
): Promise<Candidate[]> {
  const searchTerms = uniqueTerms([...plan.titles, plan.query, ...plan.keywords], 18);
  const searches = searchTerms.map((query) => ({ query, limit: 5 }));
  const resultSets = await searchWikidataBatch(searches);
  const excluded = new Set(excludeIds);
  const seen = new Set<number>();
  const ids: number[] = [];
  const gameMap = new Map<number, WikidataGame>();
  for (const set of resultSets) for (const game of set) gameMap.set(game.id, game);

  for (let index = 0; index < searchTerms.length; index++) {
    const first = resultSets[index]?.[0];
    if (first) addUniqueId(ids, seen, excluded, first.id, cap);
  }
  for (const set of resultSets) {
    for (const game of set) addUniqueId(ids, seen, excluded, game.id, cap);
  }

  const consoleOnly = platforms.length > 0 && !platforms.includes("steam");
  const games = ids
    .map((id) => gameMap.get(id))
    .filter((game): game is WikidataGame => Boolean(game?.name && isLikelyStandaloneName(game.name) && matchesReleaseFilter(game.releaseDate, releaseFilter)))
    .filter((game) => !consoleOnly || matchesPlatformFilter(game.platforms, platforms));

  const steamSearches = includeSteam ? await Promise.all(games.map((game) => searchStore(game.name, 3))) : games.map(() => []);
  const steamDetails = await getAppDataBatch(Array.from(new Set(steamSearches.flatMap((results) => results.map((result) => result.id)))));

  return games
    .map((wikidata, index): Candidate => {
      const expectedYear = wikidata.releaseDate ? Number(wikidata.releaseDate.slice(0, 4)) : undefined;
      const possibleSteamId = selectVerifiedSteamMatch(wikidata.name, steamSearches[index] ?? [], steamDetails, expectedYear, [...wikidata.developers, ...wikidata.publishers]);
      const steam = possibleSteamId ? steamDetails.get(possibleSteamId) ?? null : null;
      const validSteam = steam && isLikelyStandaloneSteamGame(steam) ? steam : null;
      return { key: `wikidata:${wikidata.id}`, id: wikidata.id, name: wikidata.name, gamebrain: null, wikidata, steamId: validSteam ? possibleSteamId : null, steam: validSteam, matchedPlatformNames: wikidata.platforms, similarToReference: false };
    })
    .filter((candidate) => matchesPlatformFilter(candidate.wikidata!.platforms, platforms, candidate.steamId !== null));
}

async function gatherSteamCandidates(plan: SearchPlan, excludeIds: number[], cap = STEAM_CANDIDATE_CAP, releaseFilter: ReleaseFilter = "all"): Promise<Candidate[]> {
  const searches = [
    ...plan.titles.map((term) => ({ term, count: 3 })),
    ...plan.keywords.map((term) => ({ term, count: 6 })),
  ];
  const resultSets = await Promise.all(searches.map((item) => searchStore(item.term, item.count)));
  const excluded = new Set(excludeIds);
  const seen = new Set<number>();
  const ids: number[] = [];
  for (let index = 0; index < plan.titles.length; index++) {
    const first = resultSets[index]?.[0];
    if (first) addUniqueId(ids, seen, excluded, first.id, cap);
  }
  for (const set of resultSets) for (const result of set) addUniqueId(ids, seen, excluded, result.id, cap);

  const details = await getAppDataBatch(ids);
  const candidates: Candidate[] = [];
  for (const id of ids) {
    const steam = details.get(id);
    if (!steam || !isLikelyStandaloneSteamGame(steam) || !matchesReleaseFilter(steam.release_date?.date, releaseFilter)) continue;
    candidates.push({ key: `steam:${id}`, id, name: steam.name!, gamebrain: null, wikidata: null, steamId: id, steam, matchedPlatformNames: [], similarToReference: false });
  }
  return candidates;
}

function candidateGenres(candidate: Candidate): string[] {
  if (candidate.gamebrain?.genre) return candidate.gamebrain.genre.split(/[,/]/).map((value) => value.trim()).filter(Boolean);
  return candidate.wikidata?.genres ?? candidate.steam?.genres?.map((item) => item.description) ?? [];
}

function candidateTags(candidate: Candidate): string[] {
  if (candidate.gamebrain) return candidate.gamebrain.genre ? [candidate.gamebrain.genre] : [];
  return candidate.wikidata ? [...candidate.wikidata.gameModes, ...candidate.wikidata.genres] : derivePlayerModes(candidate.steam ?? {});
}

function normalizeCompanyName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function candidateCompanies(candidate: Candidate): string[] {
  return Array.from(new Set([
    ...(candidate.wikidata?.developers ?? []),
    ...(candidate.wikidata?.publishers ?? []),
    ...(candidate.steam?.developers ?? []),
    ...(candidate.steam?.publishers ?? []),
  ])).filter(Boolean);
}

function matchesCompanyConstraint(candidate: Candidate, companies: string[]): boolean {
  if (companies.length === 0) return true;
  const known = candidateCompanies(candidate).map(normalizeCompanyName);
  if (known.length === 0) return false;
  return companies.every((company) => {
    const target = normalizeCompanyName(company);
    return known.some((name) => name === target || name.includes(target) || target.includes(name));
  });
}

function candidatePlayerModes(candidate: Candidate): string[] {
  if (candidate.gamebrain) return derivePlayerModes(candidate.steam ?? {});
  return candidate.wikidata?.gameModes ?? derivePlayerModes(candidate.steam ?? {});
}

function candidatePlatforms(candidate: Candidate): string[] {
  if (candidate.matchedPlatformNames.length > 0) return candidate.matchedPlatformNames;
  if (candidate.wikidata) return candidate.wikidata.platforms;
  const platforms = candidate.steam?.platforms;
  return [platforms?.windows ? "Windows" : "", platforms?.mac ? "macOS" : "", platforms?.linux ? "Linux" : ""].filter(Boolean);
}

function candidateReleaseDate(candidate: Candidate): string {
  if (candidate.gamebrain?.year) return `${candidate.gamebrain.year}-01-01`;
  return candidate.wikidata?.releaseDate ?? candidate.steam?.release_date?.date ?? "未知";
}

async function pickAndRank(messages: ChatMessage[], candidates: Candidate[], count: number, platforms: Platform[], previousGames: PreviousRecommendation[], releaseFilter: ReleaseFilter, intent?: RecommendationIntent, referenceProfiles: ReferenceGameProfile[] = []): Promise<{ reply: string; picks: { key: string; reason: string }[]; cacheHit: boolean }> {
  const targetCount = Math.min(count, candidates.length);
  const aiPickCount = targetCount;
  const compact = candidates.map((candidate) => ({
    key: candidate.key,
    名称: candidate.name,
    平台: candidatePlatforms(candidate).join(" / ") || "未知",
    类型: candidateGenres(candidate).join(" / "),
    玩法: candidatePlayerModes(candidate).join(" / "),
    价格: candidate.steam?.is_free ? "免费" : candidate.steam?.price_overview?.final_formatted ?? "未知",
    评分: candidate.gamebrain?.rating?.mean ? Math.round(candidate.gamebrain.rating.mean * 100) : null,
    相似参考: candidate.similarToReference,
    发售日期: candidateReleaseDate(candidate),
  }));
  const system = `你是一名中文游戏推荐专家。你只能从下方真实候选游戏中挑选，严禁编造候选之外的游戏或信息。
- 用户明确标记为“喜欢”的游戏是最强偏好信号
- 不要把用户已经喜欢的游戏本身当作新推荐
- 用户选择的平台为硬约束。当前平台偏好：${platformPreferenceText(platforms)}\n- 发售时间偏好：${releaseFilterText(releaseFilter)}\n- Structured intent: ${intent?.mode ?? "discovery"}; ${intent ? releaseConstraintText(intent.release) : "release date unrestricted"}; recency=${intent?.recencyPreference ?? "none"}
- 挑选匹配度最高的恰好 ${aiPickCount} 款，按匹配度从高到低排序；剩余结果由系统按数据库相关度补齐
- 重点核对平台、单人/多人方式、题材、玩法、难度和价格
- 每款写一句具体的中文推荐理由
- Return JSON only: {"reply":"...","picks":[{"key":"source:id","reason":"..."}]}`;
  const rankContext = {
    messages: transcript(messages),
    previousGames,
    platforms,
    releaseFilter,
    intent,
    referenceProfiles,
    candidates: compact,
    aiPickCount,
  };
  const cached = await getCachedLlmResult("final-rank", rankContext, 5 * 60 * 1000, async () => {
    const initial = await chatCompletionJson<{ reply?: string; picks?: { key?: string; reason?: string }[] }>(
      [
        { role: "system", content: system },
        { role: "user", content: `Conversation:\n${transcript(messages)}\n\nReference game profiles:\n${JSON.stringify(referenceProfiles)}\n\nPrevious recommendations:\n${JSON.stringify(previousGames)}\n\nVerified candidates:\n${JSON.stringify(compact)}` },
      ],
      { maxTokens: Math.min(RANK_MAX_TOKENS, Math.max(RANK_MIN_TOKENS, aiPickCount * 350)), temperature: 0.2 }
    );
    if (REVIEW_MAX_TOKENS <= 0) return initial;
    try {
      const reviewed = await chatCompletionJson<{ reply?: string; picks?: { key?: string; reason?: string }[] }>(
        [
          {
            role: "system",
            content: `You are a recommendation quality reviewer. Check the proposed picks against the verified candidates and hard constraints. Improve relevance, freshness, company/platform/release compliance, and diversity. Never invent keys. Return JSON only: {"reply":"...","picks":[{"key":"source:id","reason":"..."}]}.`,
          },
          {
            role: "user",
            content: JSON.stringify({ intent, platforms, releaseFilter, targetCount: aiPickCount, candidates: compact, proposed: initial.picks }),
          },
        ],
        { maxTokens: REVIEW_MAX_TOKENS, temperature: 0, model: process.env.AI_FAST_MODEL }
      );
      return { reply: reviewed.reply || initial.reply, picks: Array.isArray(reviewed.picks) && reviewed.picks.length > 0 ? reviewed.picks : initial.picks };
    } catch (error) {
      console.warn("[recommend] quality review fallback:", error instanceof Error ? error.message : error);
      return initial;
    }
  });
  const parsed = cached.value;
  const validKeys = new Set(candidates.map((candidate) => candidate.key));
  const seen = new Set<string>();
  const picks = (parsed.picks ?? []).flatMap((pick): { key: string; reason: string }[] => {
    if (typeof pick?.key !== "string" || typeof pick.reason !== "string" || !validKeys.has(pick.key) || seen.has(pick.key)) return [];
    seen.add(pick.key);
    return [{ key: pick.key, reason: pick.reason }];
  }).slice(0, aiPickCount);
  for (const candidate of candidates) {
    if (picks.length >= targetCount) break;
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    const genre = candidateGenres(candidate).slice(0, 2).join("、") || "玩法";
    picks.push({ key: candidate.key, reason: `支持${platformPreferenceText(platforms)}，以${genre}为核心，可作为符合当前偏好的补充选择。` });
  }
  if (picks.length === 0) throw new Error("AI 未能从真实候选中选出游戏，请换个说法重试");
  return { reply: parsed.reply?.trim() || "Recommendation results:", picks, cacheHit: cached.cacheHit };
}

function imageProxyUrl(url?: string): string {
  if (!url) return "";
  if (url.startsWith("/")) return url;
  return /^https?:\/\//i.test(url) ? `/api/image-proxy?url=${encodeURIComponent(url)}` : url;
}

function reviewFromGameBrain(game: GameBrainGame | null): Game["review"] {
  if (!game?.rating?.mean) return null;
  const positiveRate = Math.round(game.rating.mean * 100);
  return { label: `GameBrain ${positiveRate}/100`, positiveRate, total: game.rating.count ?? 0, source: "gamebrain" };
}

function reviewFromSteam(summary: ReviewSummary | undefined): Game["review"] {
  if (!summary || summary.total_reviews <= 0) return null;
  const positiveRate = Math.round((summary.total_positive / summary.total_reviews) * 100);
  return { label: reviewLabel(positiveRate, summary.total_reviews), positiveRate, total: summary.total_reviews, source: "steam" };
}

function formatReleaseDate(value?: string | null): string {
  if (!value) return "未知";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`;
  return value;
}

function selectStoreUrl(candidate: Candidate, platforms: Platform[]): { url: string; name: string } {
  if (candidate.gamebrain?.link) return { url: candidate.gamebrain.link, name: "GameBrain" };
  const sites = candidate.wikidata?.officialWebsites ?? [];
  if (platforms.includes("ns")) {
    const nintendo = sites.find((url) => /nintendo./i.test(url));
    if (nintendo) return { url: nintendo, name: "Nintendo Store" };
  }
  if (platforms.includes("psn")) {
    const playstation = sites.find((url) => /playstation./i.test(url));
    if (playstation) return { url: playstation, name: "PlayStation Store" };
  }
  if (candidate.steamId) return { url: `https://store.steampowered.com/app/${candidate.steamId}`, name: "Steam Store" };
  if (sites[0]) return { url: sites[0], name: "Official Site" };
  if (candidate.wikidata) return { url: wikidataPageUrl(candidate.wikidata), name: candidate.wikidata.wikipedia ? "Wikipedia" : "Wikidata" };
  return { url: "https://www.wikidata.org", name: "Wikidata" };
}

function toGame(candidate: Candidate, reason: string, reviewSummary: ReviewSummary | undefined, platforms: Platform[], enrichment?: WikipediaEnrichment): Game {
  const wiki = candidate.wikidata;
  const steam = candidate.steam;
  const platformNames = candidatePlatforms(candidate);
  const playerModes = candidatePlayerModes(candidate);
  const genres = candidateGenres(candidate);
  const tags = Array.from(new Set([...candidateTags(candidate), ...genres, ...playerModes])).slice(0, 8);
  const store = selectStoreUrl(candidate, platforms);
  const showSteamCommerce = platforms.length === 0 || platforms.includes("steam");
  return {
    id: candidate.id,
    source: candidate.gamebrain ? "gamebrain" : wiki ? "wikidata" : "steam",
    steamAppId: candidate.steamId,
    name: candidate.gamebrain?.name ?? wiki?.name ?? steam?.name ?? candidate.name,
    headerImage: imageProxyUrl(candidate.gamebrain?.image ?? steam?.header_image ?? enrichment?.imageUrl ?? wiki?.imageUrl) || `/api/game-placeholder?name=${encodeURIComponent(candidate.name)}`,
    shortDescription: (candidate.gamebrain?.short_description ?? steam?.short_description ?? enrichment?.summary ?? wiki?.description ?? "").replace(/\s+/g, " ").trim(),
    reason,
    genres,
    tags,
    playerModes,
    platformNames,
    price: {
      formatted: showSteamCommerce ? (steam?.is_free ? "免费" : steam?.price_overview?.final_formatted ?? "暂无价格") : "主机价格未提供",
      finalCny: showSteamCommerce ? (steam?.is_free ? 0 : steam?.price_overview ? steam.price_overview.final / 100 : null) : null,
      discountPercent: showSteamCommerce ? steam?.price_overview?.discount_percent ?? 0 : 0,
    },
    releaseDate: formatReleaseDate(candidateReleaseDate(candidate)),
    releaseTimestamp: candidate.gamebrain?.year ? Date.UTC(candidate.gamebrain.year, 0, 1) : wiki?.releaseTimestamp ?? parseReleaseTimestamp(steam?.release_date?.date),
    developers: wiki?.developers ?? steam?.developers ?? [],
    publishers: wiki?.publishers ?? steam?.publishers ?? [],
    platforms: {
      windows: platformNames.some((name) => /pc|windows/i.test(name)),
      mac: platformNames.some((name) => /mac/i.test(name)),
      linux: platformNames.some((name) => /linux/i.test(name)),
    },
    metacritic: steam?.metacritic?.score ?? null,
    review: reviewFromSteam(reviewSummary) ?? reviewFromGameBrain(candidate.gamebrain),
    playtimeHours: null,
    storeUrl: store.url,
    storeName: store.name,
  };
}

function candidatePoolStats(candidates: Candidate[], intent: RecommendationIntent): {
  total: number;
  recent: number;
  unknownRelease: number;
  similarToReference: number;
  genres: string[];
} {
  const currentYear = new Date().getFullYear();
  return {
    total: candidates.length,
    recent: candidates.filter((candidate) => {
      const value = candidateReleaseDate(candidate);
      return typeof value === "string" && Number(value.slice(0, 4)) >= currentYear - 5;
    }).length,
    unknownRelease: candidates.filter((candidate) => candidateReleaseDate(candidate) === "??").length,
    similarToReference: candidates.filter((candidate) => candidate.similarToReference).length,
    genres: Array.from(new Set(candidates.flatMap((candidate) => candidateGenres(candidate)))).slice(0, 12),
  };
}

function referenceOverlap(candidate: Candidate, profiles: ReferenceGameProfile[]): number {
  const profileSummary = summarizeReferenceProfiles(profiles);
  const candidateValues = new Set([
    ...candidateGenres(candidate).map((value) => value.toLocaleLowerCase()),
    ...candidatePlayerModes(candidate).map((value) => value.toLocaleLowerCase()),
    ...candidateTags(candidate).map((value) => value.toLocaleLowerCase()),
  ]);
  const referenceValues = [...profileSummary.genres, ...profileSummary.playerModes, ...profileSummary.tags].map((value) => value.toLocaleLowerCase());
  return referenceValues.reduce((score, value) => score + (candidateValues.has(value) ? 1 : 0), 0);
}

function candidatePreferenceScore(candidate: Candidate, profiles: ReferenceGameProfile[], intent: RecommendationIntent): number {
  let score = referenceOverlap(candidate, profiles) * 10;
  if (candidate.similarToReference) score += 12;
  if (intent.mode === "exact_lookup") score += 100;
  const year = Number(candidateReleaseDate(candidate).slice(0, 4));
  if (intent.recencyPreference === "prefer_newest" && Number.isFinite(year)) {
    score += Math.max(0, year - (new Date().getFullYear() - 5)) * 8;
  } else if (intent.release.from === null && intent.release.to === null && Number.isFinite(year) && year >= new Date().getFullYear() - 5) {
    score += 3;
  }
  if (candidate.steam?.metacritic || candidate.gamebrain?.rating) score += 1;
  return score;
}

function preRankCandidates(candidates: Candidate[], profiles: ReferenceGameProfile[], intent: RecommendationIntent): Candidate[] {
  const ranked = [...candidates].sort((a, b) => candidatePreferenceScore(b, profiles, intent) - candidatePreferenceScore(a, profiles, intent));
  const genreCounts = new Map<string, number>();
  const selected: Candidate[] = [];
  const remaining = [...ranked];
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const primaryGenre = candidateGenres(candidate)[0]?.toLocaleLowerCase() ?? "unknown";
      const diversityPenalty = (genreCounts.get(primaryGenre) ?? 0) >= 3 && intent.mode !== "exact_lookup" ? 4 : 0;
      const score = candidatePreferenceScore(candidate, profiles, intent) - diversityPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const candidate = remaining.splice(bestIndex, 1)[0];
    selected.push(candidate);
    const primaryGenre = candidateGenres(candidate)[0]?.toLocaleLowerCase() ?? "unknown";
    genreCounts.set(primaryGenre, (genreCounts.get(primaryGenre) ?? 0) + 1);
  }
  return selected;
}

type AgentSearchStrategy = "catalog" | "similar" | "franchise" | "newest";

interface RecommendationAgentAction {
  action: "search" | "finalize";
  strategy?: AgentSearchStrategy;
  query?: string;
  references?: unknown[];
  titles?: unknown[];
  keywords?: unknown[];
  rationale?: string;
}

interface AgentSearchRecord {
  strategy: AgentSearchStrategy;
  query: string;
  references: string[];
  added: number;
  gameBrainCandidates: number;
  observedGames: { key: string; name: string; year: string; genre: string }[];
  rationale: string;
}

interface AgentTurnTiming {
  turn: number;
  action: "search" | "finalize" | "fallback";
  decisionMs: number;
  decisionCacheHit: boolean;
  toolMs: number;
  gameBrainMs: number;
  fallbackMs: number;
  candidateCount: number;
  added: number;
  query?: string;
}



function normalizeAgentPlan(action: RecommendationAgentAction, messages: ChatMessage[], releaseFilter: ReleaseFilter): SearchPlan {
  const latestUser = messages.filter((message) => message.role === "user").at(-1)?.content ?? "video games";
  const query = typeof action.query === "string" && action.query.trim() ? action.query.trim().slice(0, 180) : latestUser.slice(0, 180);
  const titles = uniqueTerms(action.titles ?? [], 10);
  const keywords = uniqueTerms(action.keywords ?? [], 6);
  return {
    query,
    titles: titles.length > 0 ? titles : [query],
    keywords: keywords.length > 0 ? keywords : [releaseFilterText(releaseFilter)],
  };
}

function agentCandidateSummary(candidates: Candidate[]): unknown[] {
  return candidates.slice(0, RANK_POOL_CAP).map((candidate) => ({
    key: candidate.key,
    name: candidate.name,
    releaseDate: candidateReleaseDate(candidate),
    platforms: candidatePlatforms(candidate).slice(0, 5),
    genres: candidateGenres(candidate).slice(0, 5),
    playerModes: candidatePlayerModes(candidate).slice(0, 5),
    similarToReference: candidate.similarToReference,
  }));
}

async function decideRecommendationAgentAction(
  messages: ChatMessage[],
  platforms: Platform[],
  count: number,
  previousGames: PreviousRecommendation[],
  releaseFilter: ReleaseFilter,
  candidates: Candidate[],
  history: AgentSearchRecord[],
  turn: number,
  intent: RecommendationIntent,
  referenceProfiles: ReferenceGameProfile[],
  excludeKeys: string[]
): Promise<{ action: RecommendationAgentAction; cacheHit: boolean }> {
  const system = `You are the search-and-recommendation agent for a real game database. Work in bounded turns. In each turn choose exactly one action: search or finalize.

Rules:
- Use search when the candidate pool is too small, too repetitive, misses the requested platform, or lacks the requested release period.
- A search must choose one strategy: catalog (broad semantic retrieval), similar (expand a resolved reference game), franchise (search a game series), or newest (search the newest compatible games).
- A search must be a meaningfully different compact English query and may include 1-5 concrete game titles plus 2-6 short genre/mechanic keywords.
- Use finalize only when the current candidates contain enough plausible, diverse real games for the requested count. Never finalize an empty or obviously insufficient pool.
- Respect the selected platforms, release preference, and any requested company/publisher as hard constraints.
- Do not invent game names; all search results will be verified by real data sources.
- If release preference is unrestricted, actively look for compatible recent games instead of relying only on famous older games.
- Avoid unnecessary searches.

Return JSON only:
{"action":"search","strategy":"catalog|similar|franchise|newest","query":"...","references":["..."],"titles":["..."],"keywords":["..."],"rationale":"..."}
or
{"action":"finalize","rationale":"..."}`;
  const dynamicContext = {
    turn: turn + 1,
    maxTurns: MAX_AGENT_TURNS,
    platforms,
    count,
    releaseFilter,
    intent: { mode: intent.mode, referenceGames: intent.referenceGames, companies: intent.companies, release: intent.release, recencyPreference: intent.recencyPreference, releaseText: releaseConstraintText(intent.release) },
    referenceProfiles,
    excludeKeys,
    coverage: candidatePoolStats(candidates, intent),
    conversation: transcript(messages),
    previousGames,
    history,
    candidates: agentCandidateSummary(candidates),
  };
  const cached = await getCachedLlmResult("agent-decision", dynamicContext, 15 * 60 * 1000, () => chatCompletionJson<RecommendationAgentAction>([
    { role: "system", content: system },
    { role: "user", content: `Turn ${turn + 1} of ${MAX_AGENT_TURNS}.
${JSON.stringify(dynamicContext)}` },
  ], { maxTokens: AGENT_MAX_TOKENS, temperature: 0, model: process.env.AI_FAST_MODEL }));
  return { action: cached.value, cacheHit: cached.cacheHit };
}

async function gatherAgentCandidates(
  plan: SearchPlan,
  excludeIds: number[],
  platforms: Platform[],
  count: number,
  messages: ChatMessage[],
  releaseFilter: ReleaseFilter,
  intent: RecommendationIntent,
  strategy: AgentSearchStrategy,
  actionReferences: string[]
): Promise<{
  candidates: Candidate[];
  usingGameBrain: boolean;
  usingWikidata: boolean;
  gameBrainCandidates: number;
  timing: { totalMs: number; gameBrainMs: number; fallbackMs: number };
}> {
  const started = Date.now();
  const steamOnly = platforms.length === 1 && platforms[0] === "steam";
  let candidates: Candidate[] = [];
  let usingGameBrain = false;
  let usingWikidata = false;
  let gameBrainMs = 0;
  let fallbackMs = 0;

  if (isGameBrainConfigured()) {
    const gameBrainStarted = Date.now();
    try {
      candidates = await gatherGameBrainCandidates(plan, excludeIds, platforms, count, messages, releaseFilter, intent, strategy, actionReferences);
      usingGameBrain = candidates.length > 0;
    } catch (error) {
      if (!(error instanceof GameBrainUnavailableError || error instanceof GameBrainQuotaError)) throw error;
      console.warn("[recommend-agent] GameBrain fallback:", error instanceof Error ? error.message : error);
    } finally {
      gameBrainMs = Date.now() - gameBrainStarted;
    }
  }

  if (candidates.length < count) {
    const fallbackStarted = Date.now();
    const fallback = steamOnly
      ? await gatherSteamCandidates(plan, excludeIds, STEAM_CANDIDATE_CAP, releaseFilter)
      : await gatherWikidataCandidates(plan, excludeIds, true, platforms, WIKIDATA_CANDIDATE_CAP, releaseFilter);
    fallbackMs = Date.now() - fallbackStarted;
    const seen = new Set(candidates.map((candidate) => candidate.id));
    for (const candidate of fallback) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      candidates.push(candidate);
      if (candidates.length >= Math.max(count, 30)) break;
    }
    usingWikidata = !steamOnly && fallback.length > 0;
  }

  return { candidates, usingGameBrain, usingWikidata, gameBrainCandidates: candidates.filter((candidate) => candidate.gamebrain !== null).length, timing: { totalMs: Date.now() - started, gameBrainMs, fallbackMs } };
}

function candidateMatchesIntent(candidate: Candidate, intent: RecommendationIntent): boolean {
  if (!matchesReleaseConstraint(candidateReleaseDate(candidate), intent.release)) return false;
  if (!matchesCompanyConstraint(candidate, intent.companies)) return false;
  if (intent.mode !== "exact_lookup" || intent.referenceGames.length === 0) return true;
  const candidateName = normalizeGameName(candidate.name);
  return intent.referenceGames.some((reference) => {
    const target = normalizeGameName(reference);
    return candidateName === target || candidateName.includes(target) || target.includes(candidateName);
  });
}

async function runRecommendationAgent(
  messages: ChatMessage[],
  excludeIds: number[],
  platforms: Platform[],
  count: number,
  previousGames: PreviousRecommendation[],
  releaseFilter: ReleaseFilter,
  intent: RecommendationIntent,
  referenceProfiles: ReferenceGameProfile[],
  excludeKeys: string[],
  onProgress?: ProgressReporter
): Promise<{
  candidates: Candidate[];
  usingGameBrain: boolean;
  usingWikidata: boolean;
  turns: number;
  timings: AgentTurnTiming[];
}> {
  const candidates: Candidate[] = [];
  const seenKeys = new Set<string>();
  const excludedKeys = new Set(excludeKeys);
  const history: AgentSearchRecord[] = [];
  const timings: AgentTurnTiming[] = [];
  let usingGameBrain = false;
  let usingWikidata = false;
  let turns = 0;

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    turns = turn + 1;
    const decisionStarted = Date.now();
    reportProgress(onProgress, "agent", "Planning next search", `Round ${turn + 1}/${MAX_AGENT_TURNS}: evaluating coverage and constraints.`);
    let action: RecommendationAgentAction;
    let decisionCacheHit = false;
    let actionType: AgentTurnTiming["action"] = "finalize";
    try {
      const decision = await decideRecommendationAgentAction(messages, platforms, count, previousGames, releaseFilter, candidates, history, turn, intent, referenceProfiles, excludeKeys);
      action = decision.action;
      decisionCacheHit = decision.cacheHit;
    } catch (error) {
      console.warn("[recommend-agent] decision fallback:", error instanceof Error ? error.message : error);
      if (candidates.length >= count || turn > 0) break;
      const fallbackPlan = await buildSearchPlan(messages, platforms, previousGames, releaseFilter);
      action = { action: "search", strategy: "catalog", ...fallbackPlan, rationale: "agent decision failed; use the baseline search plan" };
      actionType = "fallback";
    }
    const decisionMs = Date.now() - decisionStarted;
    if (action.action === "search") {
      reportProgress(onProgress, "agent", "Search strategy selected", `Strategy: ${action.strategy ?? "catalog"}; query: ${typeof action.query === "string" ? action.query : "generated automatically"}`);
    } else {
      reportProgress(onProgress, "agent", "Candidate pool ready", "The current candidate pool satisfies the recommendation threshold; moving to ranking.");
    }

    const minimumPool = intent.mode === "exact_lookup" ? count : Math.min(RANK_POOL_CAP, Math.max(count + 10, count * 2));
    if (action.action === "finalize" && candidates.length >= minimumPool) {
      timings.push({ turn: turn + 1, action: actionType === "fallback" ? "fallback" : "finalize", decisionMs, decisionCacheHit, toolMs: 0, gameBrainMs: 0, fallbackMs: 0, candidateCount: candidates.length, added: 0 });
      break;
    }
    if (action.action !== "search") {
      timings.push({ turn: turn + 1, action: actionType === "fallback" ? "fallback" : "finalize", decisionMs, decisionCacheHit, toolMs: 0, gameBrainMs: 0, fallbackMs: 0, candidateCount: candidates.length, added: 0 });
      if (candidates.length >= minimumPool || turn === MAX_AGENT_TURNS - 1) break;
      continue;
    }

    const strategy: AgentSearchStrategy = action.strategy === "similar" || action.strategy === "franchise" || action.strategy === "newest" ? action.strategy : "catalog";
    const actionReferences = uniqueTerms(action.references ?? [], 2);
    const plan = normalizeAgentPlan(action, messages, releaseFilter);
    if (history.some((record) => record.strategy === strategy && record.query.toLocaleLowerCase() === plan.query.toLocaleLowerCase())) {
      timings.push({ turn: turn + 1, action: actionType === "fallback" ? "fallback" : "search", decisionMs, decisionCacheHit, toolMs: 0, gameBrainMs: 0, fallbackMs: 0, candidateCount: candidates.length, added: 0, query: plan.query });
      if (candidates.length >= count) break;
      continue;
    }

    const toolStarted = Date.now();
    reportProgress(onProgress, "tool", "Querying game data sources", `Executing ${strategy} with GameBrain, Steam, and Wikidata.`);
    const result = await gatherAgentCandidates(plan, excludeIds, platforms, count, messages, releaseFilter, intent, strategy, actionReferences);
    usingGameBrain ||= result.usingGameBrain;
    usingWikidata ||= result.usingWikidata;
    let added = 0;
    for (const candidate of result.candidates) {
      if (!candidateMatchesIntent(candidate, intent)) continue;
      if (excludedKeys.has(candidate.key) || seenKeys.has(candidate.key)) continue;
      seenKeys.add(candidate.key);
      candidates.push(candidate);
      added += 1;
      if (candidates.length >= RANK_POOL_CAP) break;
    }
    reportProgress(onProgress, "tool", "Candidate results received", `GameBrain returned ${result.gameBrainCandidates}; added ${added} verified candidates.`);
    history.push({
      strategy,
      query: plan.query,
      references: actionReferences,
      added,
      gameBrainCandidates: result.gameBrainCandidates,
      observedGames: result.candidates.slice(0, 12).map((candidate) => ({ key: candidate.key, name: candidate.name, year: candidateReleaseDate(candidate), genre: candidateGenres(candidate).join(" / ") })),
      rationale: action.rationale ?? "",
    });
    timings.push({ turn: turn + 1, action: actionType === "fallback" ? "fallback" : "search", decisionMs, decisionCacheHit, toolMs: Date.now() - toolStarted, gameBrainMs: result.timing.gameBrainMs, fallbackMs: result.timing.fallbackMs, candidateCount: candidates.length, added, query: plan.query });

    if (candidates.length >= RANK_POOL_CAP) break;
  }

  return { candidates, usingGameBrain, usingWikidata, turns, timings };
}

export async function recommend(messages: ChatMessage[], excludeIds: number[], platforms: Platform[] = [], count = 6, previousGames: PreviousRecommendation[] = [], releaseFilter: ReleaseFilter = "all", favoriteGames: string[] = [], excludeKeys: string[] = [], onProgress?: ProgressReporter): Promise<RecommendResponse> {
  const started = Date.now();
  const metricsBefore = {
    ai: aiUsageStats(),
    gamebrain: gameBrainCacheStats(),
    steam: steamCacheStats(),
    wikidata: wikidataCacheStats(),
  };
  let stageStarted = started;
  reportProgress(onProgress, "intent", "Parsing request", "Extracting reference games, companies, platforms, release constraints, and recency preferences.");
  const parsedIntent = parseRecommendationIntent(messages, favoriteGames, releaseFilter);
  const intent = await enrichRecommendationIntent(parsedIntent, messages);
  reportProgress(onProgress, "intent", "Request parsed", `Found ${intent.referenceGames.length} reference games and ${intent.companies.length} company constraints.`);
  reportProgress(onProgress, "profile", "Building preference profile", "Resolving reference games through Suggest, Steam, and Wikidata.");
  const referenceProfiles = await analyzeReferenceGames(intent.referenceGames);
  reportProgress(onProgress, "profile", "Preference profile ready", `Loaded genre and platform evidence for ${referenceProfiles.length} reference games.`);
  // New clients send source-qualified keys. Keep numeric exclusion only for
  // older persisted sessions so different providers cannot hide each other.
  const legacyExcludeIds = excludeKeys.length > 0 ? [] : excludeIds;
  const agent = await runRecommendationAgent(messages, legacyExcludeIds, platforms, count, previousGames, releaseFilter, intent, referenceProfiles, excludeKeys, onProgress);
  const candidateMs = Date.now() - stageStarted;
  stageStarted = Date.now();

  if (agent.candidates.length === 0) throw new Error("??????????????????????????????????????");

  reportProgress(onProgress, "filter", "Validating candidates", `Keeping ${agent.candidates.length} candidates that satisfy platform, company, and release constraints.`);
  const orderedCandidates = preRankCandidates(agent.candidates, referenceProfiles, intent);
  const rankPool = orderedCandidates.slice(0, Math.min(orderedCandidates.length, Math.min(RANK_POOL_CAP, Math.max(count + 20, count * 3))));
  reportProgress(onProgress, "rank", "Ranking candidates", `Selecting ${count} recommendations from ${rankPool.length} candidates.`);
  const { reply, picks, cacheHit: rankCacheHit } = await pickAndRank(messages, rankPool, count, platforms, previousGames, releaseFilter, intent, referenceProfiles);
  const rankMs = Date.now() - stageStarted;
  stageStarted = Date.now();
  const candidateMap = new Map(orderedCandidates.map((candidate) => [candidate.key, candidate]));
  const pickedCandidates = picks.map((pick) => candidateMap.get(pick.key)).filter((candidate): candidate is Candidate => Boolean(candidate));
  reportProgress(onProgress, "enrich", "Enriching game details", "Loading reviews, cover art, pricing, and store links.");
  const steamIds = pickedCandidates.map((candidate) => candidate.steamId).filter((id): id is number => typeof id === "number");
  const wikiGames = pickedCandidates.map((candidate) => candidate.wikidata).filter((game): game is WikidataGame => Boolean(game));
  const [steamReviews, wikipedia] = await Promise.all([getReviewSummaries(steamIds), getWikipediaEnrichment(wikiGames)]);

  const games = picks.map((pick) => {
    const candidate = candidateMap.get(pick.key);
    if (!candidate) return null;
    return toGame(candidate, pick.reason, candidate.steamId ? steamReviews.get(candidate.steamId) : undefined, platforms, wikipedia.get(candidate.id));
  }).filter((game): game is Game => game !== null);

  const enrichMs = Date.now() - stageStarted;
  const metrics = {
    ai: diffAiUsage(metricsBefore.ai),
    gamebrain: metricDelta(metricsBefore.gamebrain, gameBrainCacheStats()),
    steam: metricDelta(metricsBefore.steam, steamCacheStats()),
    wikidata: metricDelta(metricsBefore.wikidata, wikidataCacheStats()),
  };
  console.info(`[recommend] quality=${RECOMMEND_QUALITY} mode=${intent.mode} refs=${JSON.stringify(intent.referenceGames)} companies=${JSON.stringify(intent.companies)} release=${JSON.stringify(intent.release)} agentTurns=${agent.turns} candidates=${candidateMs}ms rank=${rankMs}ms enrich=${enrichMs}ms total=${Date.now() - started}ms gamebrain=${agent.usingGameBrain} wikidata=${agent.usingWikidata} platforms=${platforms.join(",") || "any"} release=${releaseFilter} timings=${JSON.stringify(agent.timings)} llmCache=${JSON.stringify({ rankCacheHit, ...llmCacheStats() })} metrics=${JSON.stringify(metrics)}`);
  reportProgress(onProgress, "complete", "Recommendation complete", `Generated ${games.length} game recommendations.`);
  return { reply, games };
}
