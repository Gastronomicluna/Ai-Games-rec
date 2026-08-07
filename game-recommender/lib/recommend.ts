// Recommendation pipeline: search planning -> verified Wikidata/Steam candidates -> AI ranking -> enriched result data.

import { aiUsageStats, chatCompletionJson, diffAiUsage } from "./ai";
import { getCachedLlmResult, llmCacheStats } from "./llm-cache";
import { gameBrainCacheStats, getSimilarGameBrain, searchGameBrain, suggestGameBrain, isGameBrainConfigured, type GameBrainGame, type GameBrainSearchBudget, GameBrainQuotaError, GameBrainUnavailableError } from "./gamebrain";
import { compactGameBrainSearchQuery, deterministicSearchQuery, enforceSearchQueryIntent, inferGameBrainGenres, inferGameBrainThemes, matchesCompanyNames, matchesPlatformFilter, platformPreferenceText, releaseFilterText, searchPlanKey, transcript, matchesReleaseFilter } from "./recommend-preferences";
import { analyzeReferenceGames, summarizeReferenceProfiles, type ReferenceGameProfile } from "./game-knowledge";
import { isWebSearchConfigured, searchWeb, webSearchProvider, webSearchStats, type WebSearchResult } from "./web-search";
import { extractGameNamesFromWebLists, isAllowedOfficialGameWebsite } from "./web-game-evidence";
import { getOfficialPageImage } from "./official-page-metadata";
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
// Agent decisions are compact JSON. Giving this stage an oversized output
// budget can make reasoning models spend minutes before returning the action;
// keep the quality work in retrieval, final ranking, and review instead.
const AGENT_MAX_TOKENS = RECOMMEND_QUALITY === "deep" ? 2400 : 1400;
const RANK_MAX_TOKENS = RECOMMEND_QUALITY === "deep" ? 8000 : 4000;
const RANK_MIN_TOKENS = RECOMMEND_QUALITY === "deep" ? 4000 : 1600;
const REVIEW_MAX_TOKENS = process.env.RECOMMEND_ENABLE_REVIEW === "false" ? 0 : RECOMMEND_QUALITY === "deep" ? 2200 : 0;
const MAX_AGENT_TURNS = Math.max(2, Math.min(5, Number(process.env.RECOMMEND_MAX_AGENT_TURNS ?? (RECOMMEND_QUALITY === "deep" ? 4 : 3)) || 3));
const GAMEBRAIN_RECOMMENDATION_TOKEN_BUDGET = Math.max(1, Math.min(10, Number(process.env.GAMEBRAIN_RECOMMENDATION_TOKEN_BUDGET ?? 5) || 5));
const WEB_SEARCH_MAX_REQUESTS = Math.max(0, Math.min(6, Number(process.env.WEB_SEARCH_MAX_REQUESTS ?? 6) || 0));
const WEB_EXTRACTION_MAX_TOKENS = Math.max(2_000, Math.min(20_000, Number(process.env.WEB_EXTRACTION_MAX_TOKENS ?? 8_000) || 8_000));

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
  gameBrainFiltersVerified?: boolean;
  webEvidence?: WebSearchResult[];
  webSimilarityReason?: string;
  webOfficialUrl?: string;
  webDescription?: string;
  webGenres?: string[];
  webTags?: string[];
  webPlayerModes?: string[];
  webPlatforms?: string[];
  webReleaseDate?: string;
  webDevelopers?: string[];
  webPublishers?: string[];
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
  const needsReferenceExtraction = intent.referenceGames.length === 0 && /(?:\u7c7b\u4f3c|\u50cf|\u53c2\u8003|\u753b\u98ce|\u7f8e\u672f|\u89c6\u89c9|\u6c1b\u56f4|\u9898\u6750|\u73a9\u6cd5|\u673a\u5236|\u6218\u6597\u7cfb\u7edf|similar|games?\s+like|visual\s+style|art\s+style|gameplay|mechanics)/i.test(rawText);
  const needsCompanyExtraction = intent.companies.length === 0 && /(?:\u51fa\u54c1|\u5f00\u53d1|\u53d1\u884c|\u5236\u4f5c|\u5382\u5546|\u65d7\u4e0b|\u5de5\u4f5c\u5ba4|\u516c\u53f8|developer|publisher|producer|produced|studio|games?\s+(?:by|from))/i.test(rawText);
  if (!needsReferenceExtraction && !needsCompanyExtraction) return intent;
  const context = { rawText, existingReferences: intent.referenceGames, existingCompanies: intent.companies };
  try {
    const cached = await getCachedLlmResult("intent-entities-v2", context, 60 * 60 * 1000, () => chatCompletionJson<{ references?: unknown[]; companies?: unknown[] }>([
      {
        role: "system",
        content: `Extract explicit game and company entities from a game recommendation request.
- references: game titles that the user likes, mentions, or uses as a reference for visual style, art direction, atmosphere, theme, gameplay, mechanics, or combat.
- companies: requested developer, publisher, studio, or platform-holder names. Use a canonical English name when known.
- Do not infer a company unless the user explicitly asks for it.
Return JSON only: {"references":["..."],"companies":["..."]}`,
      },
      { role: "user", content: JSON.stringify(context) },
    ], { maxTokens: ENTITY_MAX_TOKENS, temperature: 0, model: process.env.AI_FAST_MODEL }));
    const references = mergeUniqueNames(intent.referenceGames, uniqueTerms(cached.value.references ?? [], 6));
    const companies = mergeUniqueNames(intent.companies, uniqueTerms(cached.value.companies ?? [], 6));
    return { ...intent, mode: intent.mode === "discovery" && references.length > 0 ? "similar_games" : intent.mode, referenceGames: references, companies };
  } catch (error) {
    console.warn("[intent] entity enrichment fallback:", error instanceof Error ? error.message : error);
    return intent;
  }
}

function releaseHintForFilter(filter: ReleaseFilter): string {
  const currentYear = new Date().getFullYear();
  if (filter === "recent" || filter === "last5") return ` released ${currentYear - 4} or newer`;
  if (filter === "classic" || filter === "before2020") return " released before 2020";
  if (filter === "last1") return ` released ${currentYear - 1} or newer`;
  if (filter === "last3") return ` released ${currentYear - 2} or newer`;
  if (filter === "before2010") return " released before 2010";
  return "";
}

function relativeReleaseSearchText(filter: ReleaseFilter): string | null {
  const currentYear = new Date().getFullYear();
  if (filter === "last1") return `released in ${currentYear - 1} or ${currentYear}`;
  if (filter === "last3") return `released from ${currentYear - 2} through ${currentYear}, including ${currentYear}`;
  if (filter === "recent" || filter === "last5") return `released from ${currentYear - 4} through ${currentYear}, including ${currentYear}`;
  return null;
}

function withReleaseScope(reply: string, filter: ReleaseFilter): string {
  const currentYear = new Date().getFullYear();
  const scope = filter === "last1"
    ? `${currentYear - 1}–${currentYear} 年`
    : filter === "last3"
      ? `${currentYear - 2}–${currentYear} 年`
      : filter === "recent" || filter === "last5"
        ? `${currentYear - 4}–${currentYear} 年`
        : null;
  return scope ? `筛选范围：${scope}。${reply}` : reply;
}

function buildWebSearchQuery(
  plan: SearchPlan,
  platforms: Platform[],
  releaseFilter: ReleaseFilter,
  intent: RecommendationIntent,
  references: string[]
): string {
  const relativeReleaseText = relativeReleaseSearchText(releaseFilter);
  // For a rolling range, replace isolated years produced by the agent with the
  // complete range. Otherwise a query such as "2025 games" can exclude 2026
  // even though the downstream release-date filter correctly accepts it.
  const baseQuery = relativeReleaseText
    ? plan.query.replace(/\b(?:19|20)\d{2}\b/g, " ").replace(/\s+/g, " ").trim()
    : plan.query;
  const referenceText = references.length > 0 ? ` similar to ${references.join(" and ")}` : "";
  const platformText = platforms.length > 0 ? ` for ${platformPreferenceText(platforms)}` : "";
  const constraintText = [
    intent.companies.join(" "),
    intent.playModes.join(" "),
    intent.price.freeOnly ? "free to play" : "",
    relativeReleaseText ?? releaseConstraintText(intent.release),
  ].filter(Boolean).join(" ");
  return `${baseQuery}${referenceText}${platformText} ${constraintText} best video games recommendations`.replace(/\s+/g, " ").trim().slice(0, 320);
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
- Treat developer and publisher names as soft discovery/ranking signals; do not exclude otherwise relevant games
- keywords: 3-5 short English genre, theme, or mechanic phrases for fallback search
- Output JSON only: {"query":"Hades beginner friendly action roguelike","titles":["..."],"keywords":["..."]}`;

  let parsed: { query?: unknown; titles?: unknown[]; keywords?: unknown[] };
  try {
    parsed = await chatCompletionJson<{ query?: unknown; titles?: unknown[]; keywords?: unknown[] }>(
      [
        { role: "system", content: system },
        { role: "user", content: `Selected platforms: ${platformPreferenceText(platforms)}\nRelease preference: ${releaseFilterText(releaseFilter)}\n\nConversation:\n${transcript(messages)}\n\nPreviously recommended games (use these to understand what to revise or avoid):\n${JSON.stringify(previousGames)}` },
      ],
      { maxTokens: 3_200, temperature: 0.3, model: process.env.AI_FAST_MODEL, timeoutMs: 60_000, maxAttempts: 2, jsonAttempts: 1 }
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
      const companies = [...(app.developers ?? []), ...(app.publishers ?? [])];
      const matchesCompany = matchesCompanyNames(companies, expectedCompanies);
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
  mobile: ["android", "ios"],
};

const PLATFORM_DISPLAY_NAMES: Record<Platform, string> = {
  steam: "Windows / Steam",
  psn: "PlayStation",
  ns: "Nintendo Switch",
  mobile: "Android / iOS",
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

function gameBrainIntentFilters(intent: RecommendationIntent | undefined, plan: SearchPlan, messages: ChatMessage[]): { key: string; values: { value: string }[]; connection: "AND" | "OR" }[] {
  if (!intent) return [];
  const filters: { key: string; values: { value: string }[]; connection: "AND" | "OR" }[] = [];
  const genres = inferGameBrainGenres(messages, plan.query, plan.keywords);
  const themes = inferGameBrainThemes(messages, plan.query, plan.keywords);
  if (genres.length > 0) {
    filters.push({ key: "genre", values: genres.map((value) => ({ value })), connection: "OR" });
  }
  if (themes.length > 0) {
    filters.push({ key: "theme", values: themes.map((value) => ({ value })), connection: "OR" });
  }
  if (intent.playModes.length > 0) {
    filters.push({ key: "play_mode", values: intent.playModes.map((value) => ({ value })), connection: "AND" });
  }
  if (intent.price.freeOnly) {
    filters.push({ key: "price", values: [{ value: "free" }], connection: "OR" });
  } else if (intent.price.maxUsd !== null) {
    const bucket = intent.price.maxUsd <= 5 ? "under_5" : intent.price.maxUsd <= 15 ? "under_15" : intent.price.maxUsd <= 25 ? "under_25" : "under_40";
    filters.push({ key: "price", values: [{ value: bucket }], connection: "OR" });
  }
  return filters;
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
  actionReferences: string[] = [],
  searchBudget?: GameBrainSearchBudget
): Promise<Candidate[]> {
  const platformKeys = Array.from(new Set(platforms.flatMap((platform) => GAMEBRAIN_PLATFORM_KEYS[platform])));
  const lookupReferences = actionReferences.length > 0
    ? actionReferences.slice(0, 2)
    : intent?.referenceGames.length ? intent.referenceGames.slice(0, 2) : referenceGameNames(messages);
  const references = strategy === "similar" ? lookupReferences : [];
  const referenceKeys = new Set(references.map((name) => normalizeGameName(name)).filter(Boolean));
  const compactQuery = compactGameBrainSearchQuery(plan.query, plan.titles, lookupReferences, messages, releaseFilter);
  const releaseHint = releaseFilter === "last1"
    ? ""
    : intent && (intent.release.from || intent.release.to)
    ? ` ${releaseConstraintText(intent.release)}`
    : releaseHintForFilter(releaseFilter);
  const naturalQuery = `${compactQuery}${releaseHint}`.replace(/\s+/g, " ").trim();
  const baseQueries = references.length > 0
    ? [references.join(" "), ...(naturalQuery && normalizeGameName(naturalQuery) !== normalizeGameName(references.join(" ")) ? [naturalQuery] : [])]
    : [naturalQuery || plan.query];
  // Similar Games can be empty for a recently released sequel. When freshness
  // matters, explicitly search the reference franchise sorted by release date.
  const franchiseQueries = strategy === "franchise" || intent?.recencyPreference === "prefer_newest"
    ? lookupReferences.map(franchiseQuery).filter((query): query is string => Boolean(query))
    : [];
  const supplementaryQueries = strategy === "catalog" || strategy === "newest"
    ? [...plan.keywords.slice(0, 2), ...plan.titles.slice(0, 2)]
    : [];
  // A recommendation run gets one Search query. The client may fetch at most
  // two ten-result pages, and only fetches page two when page one is short of
  // the number of recommendations requested by the user.
  const query = uniqueTerms([...baseQueries, ...franchiseQueries, ...supplementaryQueries], 1)[0] ?? plan.query;
  const currentYear = new Date().getFullYear();
  const releaseFilterValues = strategy === "newest" || intent?.recencyPreference === "prefer_newest"
    ? [{ key: "release_date", values: [{ value: "last_5_years" }], connection: "OR" as const }]
    : intent?.release.from && Number(intent.release.from.slice(0, 4)) >= currentYear - 1
      ? [{ key: "release_date", values: [{ value: "last_5_years" }], connection: "OR" as const }]
      : intent?.release.from && Number(intent.release.from.slice(0, 4)) >= currentYear - 5
        ? [{ key: "release_date", values: [{ value: "last_5_years" }], connection: "OR" as const }]
        : [];
  const intentFilters = gameBrainIntentFilters(intent, plan, messages);
  const filters = [...releaseFilterValues, ...intentFilters];
  // Keep GameBrain's semantic relevance order for ordinary release filters.
  // Sorting every recent query by release date promotes obscure new entries
  // over games that actually match the requested genre and mechanics.
  const searchOptions = strategy === "newest" || intent?.recencyPreference === "prefer_newest"
    ? { filters, sort: "release_date" as const, sortOrder: "desc" as const }
    : { filters };
  const games: GameBrainGame[] = [];
  const filteredSearchIds = new Set<number>();
  const similarIds = new Set<number>();
  const searchedGamesPromise = searchGameBrain(query, platformKeys, 20, 0, {
    ...searchOptions,
    minimumResults: count,
    maxPages: Math.min(2, searchBudget?.remaining ?? 2),
    requestBudget: searchBudget,
  });
  // Suggest is inexpensive and independent from Search. Starting both at the
  // same time removes one complete network round trip for favorite-based runs.
  const suggestionSetsPromise = lookupReferences.length > 0
    ? Promise.all(lookupReferences.map((reference) => suggestGameBrain(reference, 5).catch(() => [])))
    : Promise.resolve([] as GameBrainGame[][]);
  const [searchedGames, suggestionSets] = await Promise.all([searchedGamesPromise, suggestionSetsPromise]);
  for (const game of searchedGames) filteredSearchIds.add(game.id);
  games.push(...searchedGames);

  if (lookupReferences.length > 0) {
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
  const hasHardGameBrainFilters = intentFilters.length > 0;
  const filtered = mergedGames.filter((game) => !excluded.has(game.id) && isLikelyStandaloneName(game.name) && matchesReleaseFilter(game.year, releaseFilter) && !referenceKeys.has(normalizeGameName(game.name)))
    .filter((game) => !hasHardGameBrainFilters || filteredSearchIds.has(game.id));
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
        gameBrainFiltersVerified: hasHardGameBrainFilters && filteredSearchIds.has(game.id),
      };
    })
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
  const rawSearches = [
    ...plan.titles.map((term) => ({ term, count: 3 })),
    { term: plan.query, count: 6 },
    ...plan.keywords.map((term) => ({ term, count: 6 })),
  ];
  const seenTerms = new Set<string>();
  const searches = rawSearches.filter((item) => {
    const key = item.term.trim().toLocaleLowerCase();
    if (!key || seenTerms.has(key)) return false;
    seenTerms.add(key);
    return true;
  }).slice(0, 10);
  const resultSets = await Promise.all(searches.map((item) => searchStore(item.term, item.count)));
  const excluded = new Set(excludeIds);
  const seen = new Set<number>();
  const ids: number[] = [];
  for (let index = 0; index < Math.min(plan.titles.length, resultSets.length); index++) {
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

interface WebDiscoveredGame {
  name?: unknown;
  similarityReason?: unknown;
  sourceUrls?: unknown[];
}

interface WebOfficialGame {
  name?: unknown;
  officialUrl?: unknown;
  description?: unknown;
  platforms?: unknown[];
  genres?: unknown[];
  gameplay?: unknown[];
  visualStyle?: unknown[];
  playerModes?: unknown[];
  releaseDate?: unknown;
  developers?: unknown[];
  publishers?: unknown[];
  evidenceUrls?: unknown[];
}

interface WebReferenceProfile {
  requestedName?: unknown;
  matchedName?: unknown;
  genres?: unknown[];
  playerModes?: unknown[];
  visualStyle?: unknown[];
  gameplay?: unknown[];
  platforms?: unknown[];
  releaseDate?: unknown;
  evidenceUrls?: unknown[];
}

interface WebToolBudget {
  remaining: number;
  used: number;
}

function stableWebCandidateId(name: string, officialUrl: string): number {
  const input = `${normalizeGameName(name)}|${officialUrl.toLocaleLowerCase()}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

function stringArray(values: unknown[] | undefined, limit: number): string[] {
  return uniqueTerms(values ?? [], limit);
}

function mergeReferenceProfileEvidence(existing: ReferenceGameProfile[], researched: ReferenceGameProfile[]): ReferenceGameProfile[] {
  const researchedByName = new Map(researched.map((profile) => [normalizeGameName(profile.requestedName), profile]));
  const merged = existing.map((profile) => {
    const web = researchedByName.get(normalizeGameName(profile.requestedName));
    if (!web) return profile;
    const webProvidesLatinCanonicalName = /[a-z]/i.test(web.matchedName);
    const existingIsUnresolved = normalizeGameName(profile.matchedName) === normalizeGameName(profile.requestedName) || !/[a-z]/i.test(profile.matchedName);
    return {
      ...profile,
      matchedName: webProvidesLatinCanonicalName && existingIsUnresolved ? web.matchedName : profile.matchedName || web.matchedName,
      genres: Array.from(new Set([...profile.genres, ...web.genres])).slice(0, 10),
      playerModes: Array.from(new Set([...profile.playerModes, ...web.playerModes])).slice(0, 10),
      tags: Array.from(new Set([...profile.tags, ...web.tags])).slice(0, 18),
      visualStyle: Array.from(new Set([...(profile.visualStyle ?? []), ...web.visualStyle])).slice(0, 12),
      gameplay: Array.from(new Set([...(profile.gameplay ?? []), ...web.gameplay])).slice(0, 12),
      platforms: Array.from(new Set([...profile.platforms, ...web.platforms])).slice(0, 10),
      releaseDate: profile.releaseDate ?? web.releaseDate,
      sources: Array.from(new Set([...profile.sources, ...web.sources])),
    };
  });
  const existingNames = new Set(existing.map((profile) => normalizeGameName(profile.requestedName)));
  return [...merged, ...researched.filter((profile) => !existingNames.has(normalizeGameName(profile.requestedName)))];
}

async function researchReferenceProfiles(
  references: string[],
  budget: WebToolBudget
): Promise<ReferenceGameProfile[]> {
  const requestedNames = uniqueTerms(references, 2);
  if (requestedNames.length === 0 || budget.remaining < 1 || !isWebSearchConfigured()) return [];
  const query = `${requestedNames.map((name) => `"${name}"`).join(" OR ")} video game visual style art direction gameplay mechanics official`.slice(0, 320);
  budget.remaining -= 1;
  budget.used += 1;
  const results = await searchWeb(query, { maxResults: 10 });
  if (results.length === 0) return [];
  const evidence = results.map((result) => ({ title: result.title, url: result.url, snippet: result.snippet, domain: result.domain }));
  const cached = await getCachedLlmResult("reference-game-web-profile", { requestedNames, evidence }, 24 * 60 * 60 * 1000, () => chatCompletionJson<{ profiles?: WebReferenceProfile[] }>([
    {
      role: "system",
      content: `Research the supplied reference games from web-search evidence.
- Return only requested game titles and only facts explicitly supported by titles or snippets.
- Focus on visual style, art direction, atmosphere, gameplay loop, mechanics, combat, genre, player modes, and platforms.
- Use short reusable English trait phrases rather than prose.
- evidenceUrls may contain only exact supplied URLs.
Return JSON only: {"profiles":[{"requestedName":"...","matchedName":"...","genres":[],"playerModes":[],"visualStyle":[],"gameplay":[],"platforms":[],"releaseDate":"YYYY-MM-DD or YYYY or empty","evidenceUrls":[]}]}`,
    },
    { role: "user", content: JSON.stringify({ requestedNames, evidence }) },
  ], { maxTokens: 4_000, temperature: 0, model: process.env.AI_FAST_MODEL, timeoutMs: 45_000, maxAttempts: 1, jsonAttempts: 1 }));
  const requestedByName = new Map(requestedNames.map((name) => [normalizeGameName(name), name]));
  const allowedUrls = new Set(results.map((result) => result.url));
  return (cached.value.profiles ?? []).flatMap((raw): ReferenceGameProfile[] => {
    const rawRequested = typeof raw.requestedName === "string" ? raw.requestedName.trim() : "";
    const requestedName = requestedByName.get(normalizeGameName(rawRequested));
    if (!requestedName) return [];
    const genres = stringArray(raw.genres, 8);
    const playerModes = stringArray(raw.playerModes, 8);
    const visualStyle = stringArray(raw.visualStyle, 10);
    const gameplay = stringArray(raw.gameplay, 10);
    const platforms = stringArray(raw.platforms, 8);
    const evidenceUrls = stringArray(raw.evidenceUrls, 6).filter((url) => allowedUrls.has(url));
    const releaseDate = typeof raw.releaseDate === "string" && /^\d{4}(?:-\d{2}-\d{2})?$/.test(raw.releaseDate.trim()) ? raw.releaseDate.trim() : null;
    return [{
      requestedName,
      matchedName: typeof raw.matchedName === "string" && raw.matchedName.trim() ? raw.matchedName.trim() : requestedName,
      genres,
      playerModes,
      tags: Array.from(new Set([...genres, ...playerModes, ...visualStyle, ...gameplay])).slice(0, 18),
      visualStyle,
      gameplay,
      platforms,
      releaseDate,
      sources: evidenceUrls.map((url) => new URL(url).hostname.replace(/^www\./, "")),
    }];
  });
}

function buildStructuredMobileCandidates(
  requestedNames: string[],
  discoveredByName: Map<string, { name: string; similarityReason: string; sourceUrls: string[] }>,
  wikidataSets: WikidataGame[][],
  officialResults: WebSearchResult[],
  searchResults: WebSearchResult[]
): Candidate[] {
  return requestedNames.flatMap((requestedName, index): Candidate[] => {
    const key = normalizeGameName(requestedName);
    const discoveredGame = discoveredByName.get(key);
    const wiki = wikidataSets[index]?.find((game) => {
      const wikiKey = normalizeGameName(game.name);
      return wikiKey === key || (Math.min(wikiKey.length, key.length) >= 5 && (wikiKey.includes(key) || key.includes(wikiKey)));
    });
    if (!discoveredGame || !wiki) return [];
    const mobilePlatforms = wiki.platforms.filter((platform) => /android|ios|iphone|ipad|mobile/i.test(platform));
    const officialWebsites = wiki.officialWebsites.filter(isAllowedOfficialGameWebsite);
    if (mobilePlatforms.length === 0 || officialWebsites.length === 0) return [];
    const officialDomains = new Map(officialWebsites.flatMap((website) => {
      try {
        return [[new URL(website).hostname.toLocaleLowerCase().replace(/^www\./, ""), website] as const];
      } catch {
        return [];
      }
    }));
    const officialResult = officialResults.find((result) => isAllowedOfficialGameWebsite(result.url) && [...officialDomains.keys()].some((domain) => result.domain === domain || result.domain.endsWith(`.${domain}`) || domain.endsWith(`.${result.domain}`)));
    if (!officialResult) return [];
    const officialUrl = [...officialDomains].find(([domain]) => officialResult.domain === domain || officialResult.domain.endsWith(`.${domain}`) || domain.endsWith(`.${officialResult.domain}`))?.[1] ?? officialResult.url;
    const sourceUrls = new Set([...discoveredGame.sourceUrls, officialResult.url]);
    const webEvidence = [...searchResults, ...officialResults].filter((result) => sourceUrls.has(result.url));
    const id = stableWebCandidateId(wiki.name, officialUrl);
    return [{
      key: `web:${id}`,
      id,
      name: wiki.name,
      gamebrain: null,
      wikidata: null,
      steamId: null,
      steam: null,
      matchedPlatformNames: mobilePlatforms,
      similarToReference: true,
      webEvidence,
      webSimilarityReason: discoveredGame.similarityReason,
      webOfficialUrl: officialUrl,
      webDescription: wiki.description,
      webGenres: wiki.genres,
      webTags: Array.from(new Set([...wiki.genres, ...wiki.gameModes])).slice(0, 16),
      webPlayerModes: wiki.gameModes,
      webPlatforms: mobilePlatforms,
      webReleaseDate: wiki.releaseDate ?? undefined,
      webDevelopers: wiki.developers,
      webPublishers: wiki.publishers,
    }];
  });
}

function buildSearchVerifiedMobileCandidates(
  discovered: { name: string; similarityReason: string; sourceUrls: string[] }[],
  officialResults: WebSearchResult[],
  searchResults: WebSearchResult[]
): Candidate[] {
  return discovered.flatMap((game): Candidate[] => {
    const key = normalizeGameName(game.name);
    const domainComparableName = key.replace(/(?:mobile|online|game|the)$/g, "");
    const officialResult = officialResults.find((result) => {
      const normalizedTitle = normalizeGameName(result.title);
      const titleContainsName = key.length >= 4 && normalizedTitle.includes(key);
      const titleIsExact = normalizedTitle === key;
      const explicitlyOfficial = /\bofficial\b|\bweb store\b|\u5b98\u65b9|\u5b98\u7f51/i.test(result.title);
      const normalizedDomain = normalizeGameName(result.domain.replace(/\.(?:com|net|org|io|gg|games?)$/i, ""));
      const domainLooksLikeGame = domainComparableName.length >= 5 && (normalizedDomain.includes(domainComparableName) || domainComparableName.includes(normalizedDomain));
      const mobileEvidence = /android|\bios\b|iphone|ipad|mobile|app store|google play/i.test(`${result.title} ${result.snippet}`);
      return titleContainsName && (titleIsExact || explicitlyOfficial || domainLooksLikeGame) && mobileEvidence && isAllowedOfficialGameWebsite(result.url);
    });
    if (!officialResult) return [];
    const evidenceText = `${officialResult.title} ${officialResult.snippet}`;
    const platforms = [
      /android|google play/i.test(evidenceText) ? "Android" : "",
      /\bios\b|iphone|ipad|app store/i.test(evidenceText) ? "iOS" : "",
      /mobile/i.test(evidenceText) ? "Mobile" : "",
    ].filter(Boolean);
    if (platforms.length === 0) return [];
    const sourceUrls = new Set([...game.sourceUrls, officialResult.url]);
    const webEvidence = [...searchResults, ...officialResults].filter((result) => sourceUrls.has(result.url));
    const id = stableWebCandidateId(game.name, officialResult.url);
    return [{
      key: `web:${id}`,
      id,
      name: game.name,
      gamebrain: null,
      wikidata: null,
      steamId: null,
      steam: null,
      matchedPlatformNames: platforms,
      similarToReference: true,
      webEvidence,
      webSimilarityReason: game.similarityReason,
      webOfficialUrl: officialResult.url,
      webDescription: officialResult.snippet,
      webGenres: [],
      webTags: [],
      webPlayerModes: [],
      webPlatforms: platforms,
      webDevelopers: [],
      webPublishers: [],
    }];
  });
}

async function verifyMobileOfficialSites(
  discovered: { name: string; similarityReason: string; sourceUrls: string[] }[],
  searchResults: WebSearchResult[],
  budget: WebToolBudget
): Promise<Candidate[]> {
  if (discovered.length === 0 || budget.remaining < 1 || !isWebSearchConfigured()) return [];
  const requestedNames = discovered.slice(0, 6).map((game) => game.name);
  // A combined OR query is often dominated by one famous title. Search each
  // proposed mobile game independently so every candidate gets an equal chance
  // to produce its own official-site evidence within the bounded web budget.
  const batches = requestedNames.slice(0, budget.remaining).map((name) => [name]);
  budget.remaining -= batches.length;
  budget.used += batches.length;
  const [officialResultSets, wikidataSets] = await Promise.all([
    Promise.all(batches.map((batch) => searchWeb(`"${batch[0]}" official game website Android iOS -youtube -facebook -reddit -wikipedia`.slice(0, 320), { maxResults: 10 }))),
    searchWikidataBatch(requestedNames.map((name) => ({ query: name, limit: 3 }))).catch(() => requestedNames.map(() => [] as WikidataGame[])),
  ]);
  const officialResults = officialResultSets.flat();
  if (officialResults.length === 0) return [];

  const evidence = officialResults.map((result) => ({ title: result.title, url: result.url, snippet: result.snippet, domain: result.domain }));
  const discoveredByName = new Map(discovered.map((game) => [normalizeGameName(game.name), game]));
  const structuredCandidates = buildStructuredMobileCandidates(requestedNames, discoveredByName, wikidataSets, officialResults, searchResults);
  const searchVerifiedCandidates = buildSearchVerifiedMobileCandidates(discovered, officialResults, searchResults);
  const verifiedWithoutModel = [...structuredCandidates, ...searchVerifiedCandidates].filter((candidate, index, values) => values.findIndex((value) => normalizeGameName(value.name) === normalizeGameName(candidate.name)) === index);
  console.info(`[recommend-mobile] proposed=${JSON.stringify(requestedNames)} searchResults=${officialResults.length} structured=${structuredCandidates.length} deterministic=${searchVerifiedCandidates.length}`);
  if (verifiedWithoutModel.length > 0) return verifiedWithoutModel;
  let modelOfficialGames: WebOfficialGame[] = [];
  try {
    const cached = await getCachedLlmResult("mobile-official-verification-v2", { requestedNames, evidence }, 24 * 60 * 60 * 1000, () => chatCompletionJson<{ games?: WebOfficialGame[] }>([
      {
        role: "system",
        content: `Verify mobile games using supplied web-search evidence.
- Match only the requested game titles; never add another title.
- officialUrl must be an exact supplied URL on the game's own official website or its developer/publisher website.
- App stores, Steam, wikis, social networks, forums, news sites, review sites, and list articles are not official websites.
- Keep a game only when the official evidence explicitly supports Android, iOS, iPhone, iPad, or mobile availability.
- Extract platforms, genre, gameplay, visual style, player modes, release date, developer and publisher only when supported by the supplied snippets.
- evidenceUrls may contain only exact supplied URLs.
Return JSON only: {"games":[{"name":"...","officialUrl":"https://...","description":"...","platforms":["Android","iOS"],"genres":[],"gameplay":[],"visualStyle":[],"playerModes":[],"releaseDate":"YYYY-MM-DD or YYYY or empty","developers":[],"publishers":[],"evidenceUrls":["https://..."]}]}`,
      },
      { role: "user", content: JSON.stringify({ requestedNames, evidence }) },
    ], { maxTokens: 8_000, temperature: 0, model: process.env.AI_FAST_MODEL, timeoutMs: 45_000, maxAttempts: 1, jsonAttempts: 1 }));
    modelOfficialGames = cached.value.games ?? [];
  } catch (error) {
    console.warn("[recommend] mobile official-site extraction fallback:", error instanceof Error ? error.message : error);
  }

  const allowedOfficialUrls = new Set(officialResults.filter((result) => isAllowedOfficialGameWebsite(result.url)).map((result) => result.url));
  const modelCandidates = modelOfficialGames.flatMap((raw): Candidate[] => {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const officialUrl = typeof raw.officialUrl === "string" && allowedOfficialUrls.has(raw.officialUrl) && isAllowedOfficialGameWebsite(raw.officialUrl) ? raw.officialUrl : "";
    const discoveredGame = discoveredByName.get(normalizeGameName(name));
    if (!name || !officialUrl || !discoveredGame) return [];
    const platforms = stringArray(raw.platforms, 6).filter((platform) => /android|ios|iphone|ipad|mobile/i.test(platform));
    if (platforms.length === 0) return [];
    const evidenceUrls = stringArray(raw.evidenceUrls, 5).filter((url) => allowedOfficialUrls.has(url));
    const sourceUrls = new Set([...discoveredGame.sourceUrls, officialUrl, ...evidenceUrls]);
    const webEvidence = [...searchResults, ...officialResults].filter((result) => sourceUrls.has(result.url));
    const genres = stringArray(raw.genres, 8);
    const gameplay = stringArray(raw.gameplay, 10);
    const visualStyle = stringArray(raw.visualStyle, 10);
    const playerModes = stringArray(raw.playerModes, 8);
    const releaseDate = typeof raw.releaseDate === "string" && /^\d{4}(?:-\d{2}-\d{2})?$/.test(raw.releaseDate.trim()) ? raw.releaseDate.trim() : undefined;
    const id = stableWebCandidateId(name, officialUrl);
    return [{
      key: `web:${id}`,
      id,
      name,
      gamebrain: null,
      wikidata: null,
      steamId: null,
      steam: null,
      matchedPlatformNames: platforms,
      similarToReference: true,
      webEvidence,
      webSimilarityReason: discoveredGame.similarityReason,
      webOfficialUrl: officialUrl,
      webDescription: typeof raw.description === "string" ? raw.description.trim().slice(0, 500) : "",
      webGenres: genres,
      webTags: Array.from(new Set([...visualStyle, ...gameplay, ...genres])).slice(0, 16),
      webPlayerModes: playerModes,
      webPlatforms: platforms,
      webReleaseDate: releaseDate,
      webDevelopers: stringArray(raw.developers, 6),
      webPublishers: stringArray(raw.publishers, 6),
    }];
  });
  const seen = new Set<string>();
  return [...verifiedWithoutModel, ...modelCandidates].filter((candidate) => {
    const key = normalizeGameName(candidate.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function gatherWebCandidates(
  plan: SearchPlan,
  excludeIds: number[],
  platforms: Platform[],
  count: number,
  releaseFilter: ReleaseFilter,
  intent: RecommendationIntent,
  references: string[],
  budget: WebToolBudget
): Promise<Candidate[]> {
  if (!isWebSearchConfigured() || budget.remaining < 1) return [];
  budget.remaining -= 1;
  budget.used += 1;
  const query = buildWebSearchQuery(plan, platforms, releaseFilter, intent, references);
  const results = await searchWeb(query, { maxResults: 8 });
  if (results.length === 0) return [];

  const evidence = results.map((result) => ({ title: result.title, url: result.url, snippet: result.snippet.slice(0, 500), domain: result.domain }));
  const extractedFromLists = extractGameNamesFromWebLists(results, references);
  const referenceKeys = new Set(references.map(normalizeGameName));
  const extractedFromPlan = uniqueTerms(plan.titles, 10).flatMap((name) => {
    const key = normalizeGameName(name);
    if (!key || key.length < 4 || referenceKeys.has(key) || !isLikelyStandaloneName(name)) return [];
    const supportingResults = results.filter((result) => normalizeGameName(`${result.title} ${result.snippet}`).includes(key));
    if (supportingResults.length === 0 && !platforms.includes("mobile")) return [];
    return [{
      name,
      similarityReason: supportingResults.length > 0
        ? `The supplied web evidence explicitly names ${name} in the requested recommendation context.`
        : `The recommendation agent proposed ${name}; official-site verification is required before it can become a candidate.`,
      sourceUrls: supportingResults.slice(0, 3).map((result) => result.url),
    }];
  });
  let modelGames: WebDiscoveredGame[] = [];
  if (new Set([...extractedFromPlan, ...extractedFromLists].map((game) => normalizeGameName(game.name))).size < Math.min(count, 4)) try {
    const cached = await getCachedLlmResult("web-game-discovery-v2", { query, evidence }, 30 * 60 * 1000, () => chatCompletionJson<{ games?: WebDiscoveredGame[] }>([
      {
        role: "system",
        content: `Extract real standalone video-game titles recommended by the supplied web search evidence.
- Return only games explicitly named in a title or snippet; never infer or invent a title.
- Exclude DLC, demos, soundtracks, mods, hardware, articles, and the reference games themselves.
- similarityReason must briefly state the evidence-backed shared gameplay, genre, theme, or player mode.
- sourceUrls must contain only exact URLs supplied in the evidence.
Return JSON only: {"games":[{"name":"...","similarityReason":"...","sourceUrls":["https://..."]}]}`,
      },
      { role: "user", content: JSON.stringify({ references, requestedCount: Math.max(count + 2, 6), evidence }) },
    ], { maxTokens: Math.max(WEB_EXTRACTION_MAX_TOKENS, 12_000), temperature: 0, model: process.env.AI_FAST_MODEL, timeoutMs: 45_000, maxAttempts: 1, jsonAttempts: 1 }));
    modelGames = cached.value.games ?? [];
  } catch (error) {
    console.warn("[recommend] web title extraction fallback:", error instanceof Error ? error.message : error);
  }

  const allowedUrls = new Set(results.map((result) => result.url));
  const extractedFromModel = modelGames.map((game) => ({
    name: typeof game.name === "string" ? game.name.trim() : "",
    similarityReason: typeof game.similarityReason === "string" ? game.similarityReason.trim().slice(0, 240) : "",
    sourceUrls: uniqueTerms(game.sourceUrls ?? [], 3).filter((url) => allowedUrls.has(url)),
  })).filter((game) => game.name && isLikelyStandaloneName(game.name));
  const extractedByKey = new Map<string, { name: string; similarityReason: string; sourceUrls: string[] }>();
  const discoveredGames = platforms.includes("mobile")
    ? [...extractedFromPlan, ...extractedFromLists, ...extractedFromModel]
    : [...extractedFromLists, ...extractedFromModel, ...extractedFromPlan];
  for (const game of discoveredGames) {
    const key = normalizeGameName(game.name);
    if (key && !extractedByKey.has(key)) extractedByKey.set(key, game);
  }
  const extracted = Array.from(extractedByKey.values()).slice(0, 12);
  const discoveredNames = uniqueTerms(extracted.map((game) => game.name), 12);
  if (discoveredNames.length === 0) return [];

  const shouldVerifyMobileWeb = platforms.includes("mobile") || (platforms.length === 0 && intent.companies.length > 0);
  const mobileCandidates = shouldVerifyMobileWeb
    ? (await verifyMobileOfficialSites(extracted, results, budget))
      .filter((candidate) => !excludeIds.includes(candidate.id) && matchesReleaseFilter(candidate.webReleaseDate, releaseFilter))
    : [];
  const verifiedPlan: SearchPlan = { query: discoveredNames.slice(0, 3).join(" "), titles: discoveredNames, keywords: [] };
  const databasePlatforms = platforms.filter((platform) => platform !== "mobile");
  const shouldGatherDatabaseCandidates = platforms.length === 0 || databasePlatforms.length > 0;
  const steamOnly = databasePlatforms.length === 1 && databasePlatforms[0] === "steam";
  const preferSteam = platforms.length === 0 || steamOnly;
  const shouldVerifySteam = platforms.length === 0 || databasePlatforms.includes("steam");
  const verified = !shouldGatherDatabaseCandidates
    ? []
    : platforms.length === 0
      ? (await Promise.all([
          gatherSteamCandidates(verifiedPlan, excludeIds, 24, releaseFilter),
          gatherWikidataCandidates(verifiedPlan, excludeIds, false, [], 24, releaseFilter),
        ])).flat()
      : preferSteam
        ? await gatherSteamCandidates(verifiedPlan, excludeIds, 24, releaseFilter)
        : await gatherWikidataCandidates(verifiedPlan, excludeIds, shouldVerifySteam, databasePlatforms, 24, releaseFilter);
  const extractedByName = new Map(extracted.map((game) => [normalizeGameName(game.name), game]));
  const databaseCandidates = verified.flatMap((candidate): Candidate[] => {
    const extractedGame = extractedByName.get(normalizeGameName(candidate.name));
    if (!extractedGame) return [];
    const webEvidence = extractedGame.sourceUrls.map((url) => results.find((result) => result.url === url)).filter((result): result is WebSearchResult => Boolean(result));
    return [{
      ...candidate,
      similarToReference: references.length > 0,
      webEvidence,
      webSimilarityReason: extractedGame.similarityReason,
    }];
  });
  const seenNames = new Set<string>();
  return [...mobileCandidates, ...databaseCandidates].filter((candidate) => {
    const key = normalizeGameName(candidate.name);
    if (!key || seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
}

function candidateGenres(candidate: Candidate): string[] {
  if (candidate.gamebrain?.genre) return candidate.gamebrain.genre.split(/[,/]/).map((value) => value.trim()).filter(Boolean);
  return candidate.wikidata?.genres ?? candidate.steam?.genres?.map((item) => item.description) ?? candidate.webGenres ?? [];
}

function candidateTags(candidate: Candidate): string[] {
  if (candidate.gamebrain) return candidate.gamebrain.genre ? [candidate.gamebrain.genre] : [];
  if (candidate.wikidata) return [...candidate.wikidata.gameModes, ...candidate.wikidata.genres];
  if (candidate.steam) return derivePlayerModes(candidate.steam);
  return candidate.webTags ?? [];
}

function candidateCompanies(candidate: Candidate): string[] {
  return Array.from(new Set([
    ...(candidate.wikidata?.developers ?? []),
    ...(candidate.wikidata?.publishers ?? []),
    ...(candidate.steam?.developers ?? []),
    ...(candidate.steam?.publishers ?? []),
    ...(candidate.webDevelopers ?? []),
    ...(candidate.webPublishers ?? []),
    ...(candidate.webEvidence ?? []).map((evidence) => `${evidence.title} ${evidence.snippet}`),
  ])).filter(Boolean);
}

function matchesCompanyConstraint(candidate: Candidate, companies: string[]): boolean {
  return matchesCompanyNames(candidateCompanies(candidate), companies);
}

function candidatePlayerModes(candidate: Candidate): string[] {
  if (candidate.gamebrain) return derivePlayerModes(candidate.steam ?? {});
  return candidate.wikidata?.gameModes ?? (candidate.steam ? derivePlayerModes(candidate.steam) : candidate.webPlayerModes ?? []);
}

function candidatePlatforms(candidate: Candidate): string[] {
  if (candidate.matchedPlatformNames.length > 0) return candidate.matchedPlatformNames;
  if (candidate.gamebrain?.platforms?.length) return candidate.gamebrain.platforms.map((platform) => platform.name || platform.value).filter(Boolean);
  if (candidate.wikidata) return candidate.wikidata.platforms;
  if (candidate.webPlatforms?.length) return candidate.webPlatforms;
  const platforms = candidate.steam?.platforms;
  return [platforms?.windows ? "Windows" : "", platforms?.mac ? "macOS" : "", platforms?.linux ? "Linux" : ""].filter(Boolean);
}

function candidateReleaseDate(candidate: Candidate): string {
  return candidate.steam?.release_date?.date
    ?? candidate.wikidata?.releaseDate
    ?? candidate.webReleaseDate
    ?? (candidate.gamebrain?.year ? String(candidate.gamebrain.year) : "未知");
}

function platformAwareRecommendationReason(reason: string, candidate: Candidate, platforms: Platform[]): string {
  if (platforms.length > 0) return reason;
  const actualPlatforms = candidatePlatforms(candidate).slice(0, 3).join(" / ");
  const replacement = actualPlatforms ? `可在${actualPlatforms}游玩` : "具体平台以商店页为准";
  return reason
    .replace(/支持(?:未指定|不限平台)(?:平台)?/g, replacement)
    .replace(/(?:可在|适用于)(?:未指定|不限平台)(?:平台)?/g, replacement);
}

async function pickAndRank(messages: ChatMessage[], candidates: Candidate[], count: number, platforms: Platform[], previousGames: PreviousRecommendation[], releaseFilter: ReleaseFilter, intent?: RecommendationIntent, referenceProfiles: ReferenceGameProfile[] = []): Promise<{ reply: string; picks: { key: string; reason: string }[]; cacheHit: boolean }> {
  const targetCount = Math.min(count, candidates.length);
  const aiPickCount = targetCount;
  const compact = candidates.map((candidate) => ({
    companies: candidateCompanies(candidate).slice(0, 8),
    companyPreferenceMatched: intent?.companies.length ? matchesCompanyConstraint(candidate, intent.companies) : null,
    key: candidate.key,
    名称: candidate.name,
    平台: candidatePlatforms(candidate).join(" / ") || "未知",
    类型: candidateGenres(candidate).join(" / "),
    玩法: candidatePlayerModes(candidate).join(" / "),
    价格: candidate.steam?.is_free || (candidate.gameBrainFiltersVerified && intent?.price.freeOnly) ? "免费" : candidate.steam?.price_overview?.final_formatted ?? "未知",
    评分: candidate.gamebrain?.rating?.mean ? Math.round(candidate.gamebrain.rating.mean * 100) : null,
    相似参考: candidate.similarToReference,
    联网相似证据: candidate.webSimilarityReason || null,
    联网来源: candidate.webEvidence?.map((source) => `${source.domain}: ${source.title}`).slice(0, 3) ?? [],
    发售日期: candidateReleaseDate(candidate),
  }));
  const system = `你是一名中文游戏推荐专家。你只能从下方真实候选游戏中挑选，严禁编造候选之外的游戏或信息。
- 用户明确标记为“喜欢”的游戏是最强偏好信号
- 不要把用户已经喜欢的游戏本身当作新推荐
- 用户选择的平台为硬约束。当前平台偏好：${platformPreferenceText(platforms)}\n- 发售时间偏好：${releaseFilterText(releaseFilter)}\n- Structured intent: ${intent?.mode ?? "discovery"}; ${intent ? releaseConstraintText(intent.release) : "release date unrestricted"}; recency=${intent?.recencyPreference ?? "none"}; playModes=${intent?.playModes.join(",") || "none"}; freeOnly=${intent?.price.freeOnly ?? false}; maxUsd=${intent?.price.maxUsd ?? "none"}
- 回复必须准确说明完整筛选年份范围；“近1年”在 ${new Date().getFullYear()} 年表示 ${new Date().getFullYear() - 1}–${new Date().getFullYear()} 年，不能只概括为前一年
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
  let parsed: { reply?: string; picks?: { key?: string; reason?: string }[] } = {};
  let rankCacheHit = false;
  try {
    const cached = await getCachedLlmResult("final-rank-v2", rankContext, 5 * 60 * 1000, async () => {
      const initial = await chatCompletionJson<{ reply?: string; picks?: { key?: string; reason?: string }[] }>(
      [
        { role: "system", content: system },
        { role: "user", content: `Conversation:\n${transcript(messages)}\n\nCompany preference instruction: requested companies are strong positive preferences, not exclusions. Put verified company matches ahead of non-matches and never invent a relationship.\nPlatform wording instruction: when no platform was selected, never say a game supports an unspecified platform; mention its actual verified platforms or omit the platform claim.\n\nReference game profiles:\n${JSON.stringify(referenceProfiles)}\n\nPrevious recommendations:\n${JSON.stringify(previousGames)}\n\nVerified candidates:\n${JSON.stringify(compact)}` },
      ],
      { maxTokens: Math.min(RANK_MAX_TOKENS, Math.max(RANK_MIN_TOKENS, aiPickCount * 280)), temperature: 0.2, timeoutMs: 60_000, maxAttempts: 1, jsonAttempts: 1 }
    );
      if (REVIEW_MAX_TOKENS <= 0) return initial;
      try {
        const reviewed = await chatCompletionJson<{ reply?: string; picks?: { key?: string; reason?: string }[] }>(
        [
          {
            role: "system",
            content: `You are a recommendation quality reviewer. Check the proposed picks against the verified candidates and hard constraints. Improve relevance, freshness, platform/release compliance, and diversity. Requested companies are strong positive preferences but never exclusion rules: verified company matches must rank ahead of non-matches, and company relationships must not be invented. Never invent keys. Return JSON only: {"reply":"...","picks":[{"key":"source:id","reason":"..."}]}.`,
          },
          {
            role: "user",
            content: JSON.stringify({ intent, platforms, releaseFilter, targetCount: aiPickCount, candidates: compact, proposed: initial.picks }),
          },
        ],
        { maxTokens: REVIEW_MAX_TOKENS, temperature: 0, model: process.env.AI_FAST_MODEL, timeoutMs: 60_000, maxAttempts: 1, jsonAttempts: 1 }
      );
        return { reply: reviewed.reply || initial.reply, picks: Array.isArray(reviewed.picks) && reviewed.picks.length > 0 ? reviewed.picks : initial.picks };
      } catch (error) {
        console.warn("[recommend] quality review fallback:", error instanceof Error ? error.message : error);
        return initial;
      }
    });
    parsed = cached.value;
    rankCacheHit = cached.cacheHit;
  } catch (error) {
    console.warn("[recommend] AI ranker fallback:", error instanceof Error ? error.message : error);
    parsed = { reply: "已按已验证数据和当前偏好排序。", picks: [] };
  }
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
    const platformClause = platforms.length > 0
      ? `支持${platformPreferenceText(platforms)}`
      : candidatePlatforms(candidate).length > 0
        ? `可在${candidatePlatforms(candidate).slice(0, 3).join(" / ")}游玩`
        : "具体平台以商店页为准";
    picks.push({ key: candidate.key, reason: `${platformClause}，以${genre}为核心，可作为符合当前偏好的补充选择。` });
  }
  if (picks.length === 0) throw new Error("AI 未能从真实候选中选出游戏，请换个说法重试");
  return { reply: withReleaseScope(parsed.reply?.trim() || "Recommendation results:", releaseFilter), picks, cacheHit: rankCacheHit };
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
  if (!value || value === "未知") return "未知";
  if (/^\d{4}$/.test(value)) return `${value} 年`;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const date = new Date(parsed);
  return `${date.getUTCFullYear()} 年 ${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日`;
}

function existingCandidateImage(candidate: Candidate): string | undefined {
  return candidate.gamebrain?.image ?? candidate.steam?.header_image ?? candidate.wikidata?.imageUrl;
}

function officialPageForImage(candidate: Candidate, platforms: Platform[]): string | null {
  if (candidate.webOfficialUrl) return candidate.webOfficialUrl;
  const sites = candidate.wikidata?.officialWebsites?.filter(isAllowedOfficialGameWebsite) ?? [];
  if (platforms.includes("ns")) return sites.find((url) => /nintendo\./i.test(url)) ?? sites[0] ?? null;
  if (platforms.includes("psn")) return sites.find((url) => /playstation\./i.test(url)) ?? sites[0] ?? null;
  return sites[0] ?? null;
}

async function loadOfficialPageImages(candidates: Candidate[], platforms: Platform[]): Promise<Map<string, string>> {
  const pending = candidates
    .filter((candidate) => !existingCandidateImage(candidate))
    .map((candidate) => ({ candidate, pageUrl: officialPageForImage(candidate, platforms) }))
    .filter((item): item is { candidate: Candidate; pageUrl: string } => Boolean(item.pageUrl))
    .slice(0, 12);
  const output = new Map<string, string>();
  let index = 0;
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (index < pending.length) {
      const item = pending[index++];
      const imageUrl = await getOfficialPageImage(item.pageUrl);
      if (imageUrl) output.set(item.candidate.key, imageUrl);
    }
  });
  await Promise.all(workers);
  return output;
}

function selectStoreUrl(candidate: Candidate, platforms: Platform[]): { url: string; name: string } {
  if (candidate.webOfficialUrl && platforms.includes("mobile")) {
    return { url: candidate.webOfficialUrl, name: "游戏官网" };
  }
  if (candidate.steamId && (platforms.length === 0 || platforms.includes("steam"))) {
    return { url: `https://store.steampowered.com/app/${candidate.steamId}`, name: "Steam Store" };
  }
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
  if (candidate.gamebrain?.link) return { url: candidate.gamebrain.link, name: "GameBrain" };
  if (candidate.wikidata) return { url: wikidataPageUrl(candidate.wikidata), name: candidate.wikidata.wikipedia ? "Wikipedia" : "Wikidata" };
  if (candidate.webOfficialUrl) return { url: candidate.webOfficialUrl, name: "游戏官网" };
  return { url: "https://www.wikidata.org", name: "Wikidata" };
}

function toGame(candidate: Candidate, reason: string, reviewSummary: ReviewSummary | undefined, platforms: Platform[], enrichment?: WikipediaEnrichment, officialImageUrl?: string): Game {
  const wiki = candidate.wikidata;
  const steam = candidate.steam;
  const platformNames = candidatePlatforms(candidate);
  const playerModes = candidatePlayerModes(candidate);
  const genres = candidateGenres(candidate);
  const tags = Array.from(new Set([...candidateTags(candidate), ...genres, ...playerModes])).slice(0, 8);
  const store = selectStoreUrl(candidate, platforms);
  const showSteamCommerce = platforms.length === 0 || platforms.includes("steam");
  const releaseValue = candidateReleaseDate(candidate);
  return {
    id: candidate.id,
    source: candidate.gamebrain ? "gamebrain" : wiki ? "wikidata" : steam ? "steam" : "web",
    steamAppId: candidate.steamId,
    name: candidate.gamebrain?.name ?? wiki?.name ?? steam?.name ?? candidate.name,
    headerImage: imageProxyUrl(candidate.gamebrain?.image ?? steam?.header_image ?? officialImageUrl ?? enrichment?.imageUrl ?? wiki?.imageUrl) || `/api/game-placeholder?name=${encodeURIComponent(candidate.name)}`,
    shortDescription: (candidate.gamebrain?.short_description ?? steam?.short_description ?? enrichment?.summary ?? wiki?.description ?? candidate.webDescription ?? candidate.webSimilarityReason ?? "").replace(/\s+/g, " ").trim(),
    reason,
    genres,
    tags,
    playerModes,
    platformNames,
    price: {
      formatted: candidate.webOfficialUrl && platforms.includes("mobile") ? "官网查看" : showSteamCommerce ? (steam?.is_free ? "免费" : steam?.price_overview?.final_formatted ?? "暂无价格") : "主机价格未提供",
      finalCny: showSteamCommerce ? (steam?.is_free ? 0 : steam?.price_overview ? steam.price_overview.final / 100 : null) : null,
      discountPercent: showSteamCommerce ? steam?.price_overview?.discount_percent ?? 0 : 0,
    },
    releaseDate: formatReleaseDate(releaseValue),
    releaseTimestamp: parseReleaseTimestamp(releaseValue) ?? wiki?.releaseTimestamp ?? (candidate.gamebrain?.year ? Date.UTC(candidate.gamebrain.year, 0, 1) : null),
    developers: wiki?.developers ?? steam?.developers ?? candidate.webDevelopers ?? [],
    publishers: wiki?.publishers ?? steam?.publishers ?? candidate.webPublishers ?? [],
    platforms: {
      windows: platformNames.some((name) => /pc|windows/i.test(name)),
      mac: platformNames.some((name) => /mac/i.test(name)),
      linux: platformNames.some((name) => /linux/i.test(name)),
    },
    metacritic: steam?.metacritic?.score ?? null,
    review: reviewFromSteam(reviewSummary) ?? reviewFromGameBrain(candidate.gamebrain),
    storeUrl: store.url,
    storeName: store.name,
    webSources: candidate.webEvidence?.map((source) => ({ title: source.title, url: source.url, domain: source.domain })).slice(0, 3),
  };
}

function candidatePoolStats(candidates: Candidate[], intent: RecommendationIntent): {
  total: number;
  recent: number;
  unknownRelease: number;
  similarToReference: number;
  companyMatches: number;
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
    companyMatches: intent.companies.length > 0 ? candidates.filter((candidate) => matchesCompanyConstraint(candidate, intent.companies)).length : 0,
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
  const referenceValues = [...profileSummary.genres, ...profileSummary.playerModes, ...profileSummary.tags, ...profileSummary.visualStyle, ...profileSummary.gameplay].map((value) => value.toLocaleLowerCase());
  return referenceValues.reduce((score, value) => score + (candidateValues.has(value) ? 1 : 0), 0);
}

function candidatePreferenceScore(candidate: Candidate, profiles: ReferenceGameProfile[], intent: RecommendationIntent): number {
  let score = referenceOverlap(candidate, profiles) * 10;
  if (candidate.similarToReference) score += 12;
  // Company remains a soft signal, but an explicit company-only request should
  // dominate incidental recency/rating bonuses when matching evidence exists.
  if (intent.companies.length > 0 && matchesCompanyConstraint(candidate, intent.companies)) score += 40;
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

type AgentSearchStrategy = "catalog" | "similar" | "franchise" | "newest" | "web" | "research";

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
  gameBrainStatus: "ok" | "not_used" | "budget_exhausted" | "quota_exhausted" | "unavailable";
  webCandidates: number;
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
  webMs?: number;
  fallbackMs: number;
  candidateCount: number;
  added: number;
  query?: string;
}



function normalizeAgentPlan(action: RecommendationAgentAction, messages: ChatMessage[], releaseFilter: ReleaseFilter): SearchPlan {
  const latestUser = messages.filter((message) => message.role === "user").at(-1)?.content ?? "video games";
  const proposedQuery = typeof action.query === "string" && action.query.trim() ? action.query.trim().slice(0, 180) : latestUser.slice(0, 180);
  const isDeterministicVariant = [0, 1, 2].some((variant) => proposedQuery === deterministicSearchQuery(messages, releaseFilter, variant));
  const query = isDeterministicVariant ? proposedQuery : enforceSearchQueryIntent(proposedQuery, messages, releaseFilter);
  const titles = uniqueTerms(action.titles ?? [], 10);
  const keywords = uniqueTerms(action.keywords ?? [], 6);
  return {
    query,
    // A semantic query is not a game title. Web discovery must extract real
    // titles from evidence instead of attempting to verify the whole query.
    titles,
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
    webSimilarityReason: candidate.webSimilarityReason,
    webSources: candidate.webEvidence?.map((source) => source.domain).slice(0, 3) ?? [],
  }));
}

function deterministicAgentFallbackPlan(intent: RecommendationIntent, profiles: ReferenceGameProfile[], messages: ChatMessage[], releaseFilter: ReleaseFilter, variant = 0): SearchPlan {
  const summary = summarizeReferenceProfiles(profiles);
  const resolvedReferences = uniqueTerms(profiles.map((profile) => profile.matchedName).filter((name) => !/[\u3400-\u9fff]/.test(name)), 3);
  const references = resolvedReferences.length > 0 ? resolvedReferences : intent.referenceGames;
  const allTraits = uniqueTerms([
    ...summary.visualStyle,
    ...summary.gameplay,
    ...summary.genres,
    ...summary.playerModes,
  ], 10).filter((trait) => trait.length <= 48 && trait.trim().split(/\s+/).length <= 7);
  const focusedTraits = variant % 3 === 1
    ? uniqueTerms([...summary.visualStyle, ...summary.genres], 6)
    : variant % 3 === 2
      ? uniqueTerms([...summary.gameplay, ...summary.playerModes], 6)
      : allTraits;
  const traits = uniqueTerms([...intent.companies.slice(0, 2), ...references.slice(0, 1), ...focusedTraits.slice(0, 3)], 5);
  const fallbackQuery = deterministicSearchQuery(messages, releaseFilter, variant % 3);
  const searchFocus = references.length > 0
    ? (variant % 3 === 1 ? "art style atmosphere" : variant % 3 === 2 ? "gameplay mechanics" : "similar games")
    : "video games developed published";
  const query = traits.length > 0
    ? `${traits.join(" ")} ${searchFocus}`.slice(0, 180)
    : fallbackQuery;
  return { query, titles: [], keywords: uniqueTerms(focusedTraits, 6) };
}

function gameBrainIsUnavailable(history: AgentSearchRecord[]): boolean {
  return history.some((record) => record.gameBrainStatus === "quota_exhausted" || record.gameBrainStatus === "unavailable" || record.gameBrainStatus === "budget_exhausted");
}

function deterministicFallbackStrategy(
  platforms: Platform[],
  intent: RecommendationIntent,
  profiles: ReferenceGameProfile[],
  history: AgentSearchRecord[],
  webRequestsRemaining: number,
  gameBrainRequestsRemaining: number
): AgentSearchStrategy {
  const webRequestsNeeded = platforms.includes("mobile") ? 2 : 1;
  const webAvailable = isWebSearchConfigured() && webRequestsRemaining >= webRequestsNeeded;
  const researchAlreadyAttempted = history.some((record) => record.strategy === "research");
  const referenceTraitsMissing = intent.referenceGames.length > 0
    && profiles.every((profile) => (profile.visualStyle?.length ?? 0) === 0 && (profile.gameplay?.length ?? 0) === 0);

  // Research is useful only if enough web budget remains to subsequently
  // discover and (for mobile) verify candidates.
  if (referenceTraitsMissing && !researchAlreadyAttempted && isWebSearchConfigured() && webRequestsRemaining >= webRequestsNeeded + 1) {
    return "research";
  }
  if (gameBrainIsUnavailable(history)) return webAvailable ? "web" : "catalog";
  if (isGameBrainConfigured() && gameBrainRequestsRemaining > 0) return "catalog";
  if (webAvailable) return "web";
  return "catalog";
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
  maxTurns: number,
  intent: RecommendationIntent,
  referenceProfiles: ReferenceGameProfile[],
  excludeKeys: string[],
  webRequestsRemaining: number
): Promise<{ action: RecommendationAgentAction; cacheHit: boolean }> {
  const system = `You are the search-and-recommendation agent for a real game database. Work in bounded turns. In each turn choose exactly one action: search or finalize.

Rules:
- Use search when the candidate pool is too small, too repetitive, misses the requested platform, or lacks the requested release period.
- A search must choose one strategy: catalog (broad semantic retrieval), similar (expand a resolved favorite), franchise (search a series), newest (new releases), web (discover evidence-backed candidates), or research (learn a reference game's visual style and gameplay from web evidence).
- Choose research when the user refers to a game's art direction, atmosphere, gameplay, mechanics, or combat but the reference profile lacks those traits. Research costs one web request and adds knowledge rather than candidates.
- Use web only after a database search has failed to provide enough varied candidates, or when reference-game similarity evidence is weak. Web-discovered titles are independently verified before recommendation.
- Mobile web discovery can spend a second web request to verify official websites and Android/iOS availability. Account for this before choosing tools.
- If history reports GameBrain status quota_exhausted or unavailable, do not choose catalog, similar, franchise, or newest again; use remaining web tools or finalize verified candidates.
- A search must be a meaningfully different compact English query with 2-6 short genre/mechanic keywords.
- Every web action must include 4-8 concrete standalone game titles in titles. These are proposals for official verification, not trusted facts.
- When the user asks for multiple similarity dimensions (for example visual style plus gameplay), diversify later searches by one dimension when an overly exact combination has poor coverage.
- Use finalize only when the current candidates contain enough plausible, diverse real games for the requested count. Never finalize an empty or obviously insufficient pool.
- Respect selected platforms and explicit release limits as hard constraints. Treat requested companies and publishers as soft search and ranking preferences, never as exclusion rules.
- When company preferences exist and coverage.companyMatches is below the requested count, actively use a company-focused web search to improve coverage before finalizing.
- Do not invent game names; all search results will be verified by real data sources.
- If release preference is unrestricted, actively look for compatible recent games instead of relying only on famous older games.
- For rolling release ranges, explicitly include the current year in every query. For example, last1 in 2026 means games released in 2025 or 2026, never 2025 alone.
- Avoid unnecessary searches.

Return JSON only:
{"action":"search","strategy":"catalog|similar|franchise|newest|web|research","query":"...","references":["..."],"titles":["..."],"keywords":["..."],"rationale":"..."}
or
{"action":"finalize","rationale":"..."}`;
  const dynamicContext = {
    turn: turn + 1,
    maxTurns,
    platforms,
    count,
    releaseFilter,
    intent: { mode: intent.mode, referenceGames: intent.referenceGames, companies: intent.companies, release: intent.release, recencyPreference: intent.recencyPreference, platforms: intent.platforms, playModes: intent.playModes, price: intent.price, releaseText: releaseConstraintText(intent.release) },
    referenceProfiles,
    excludeKeys,
    tools: { webSearch: { configured: isWebSearchConfigured(), provider: webSearchProvider(), requestsRemaining: webRequestsRemaining } },
    coverage: candidatePoolStats(candidates, intent),
    conversation: transcript(messages),
    previousGames,
    history,
    candidates: agentCandidateSummary(candidates),
  };
  const cached = await getCachedLlmResult("agent-decision-v3", dynamicContext, 15 * 60 * 1000, () => chatCompletionJson<RecommendationAgentAction>([
    { role: "system", content: system },
    { role: "user", content: `Turn ${turn + 1} of ${maxTurns}.
${JSON.stringify(dynamicContext)}` },
  ], { maxTokens: AGENT_MAX_TOKENS, temperature: 0, model: process.env.AI_FAST_MODEL, timeoutMs: 20_000, maxAttempts: 1, jsonAttempts: 1 }));
  if (cached.value.action !== "search" && cached.value.action !== "finalize") {
    throw new Error("Agent returned an invalid action; use the deterministic tool fallback.");
  }
  if (cached.value.action === "search" && cached.value.strategy === "web" && uniqueTerms(cached.value.titles ?? [], 10).length < 3) {
    throw new Error("A web action must propose at least three concrete titles for official verification.");
  }
  if (cached.value.action === "search" && cached.value.strategy === "research" && uniqueTerms(cached.value.references ?? [], 2).length === 0 && intent.referenceGames.length === 0) {
    throw new Error("A research action requires a reference game.");
  }
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
  actionReferences: string[],
  searchBudget: GameBrainSearchBudget,
  webBudget: WebToolBudget
): Promise<{
  candidates: Candidate[];
  usingGameBrain: boolean;
  usingWikidata: boolean;
  usingWeb: boolean;
  gameBrainStatus: "ok" | "not_used" | "budget_exhausted" | "quota_exhausted" | "unavailable";
  gameBrainCandidates: number;
  webCandidates: number;
  timing: { totalMs: number; gameBrainMs: number; webMs: number; fallbackMs: number };
}> {
  const started = Date.now();
  const steamOnly = platforms.length === 1 && platforms[0] === "steam";
  const preferSteam = platforms.length === 0 || steamOnly;
  let candidates: Candidate[] = [];
  let usingGameBrain = false;
  let usingWikidata = false;
  let usingWeb = false;
  let gameBrainStatus: "ok" | "not_used" | "budget_exhausted" | "quota_exhausted" | "unavailable" = "not_used";
  let gameBrainMs = 0;
  let webMs = 0;
  let fallbackMs = 0;

  if (strategy === "web" && webBudget.remaining > 0 && isWebSearchConfigured()) {
    const webStarted = Date.now();
    const references = actionReferences.length > 0 ? actionReferences : intent.referenceGames.slice(0, 2);
    try {
      candidates = await gatherWebCandidates(plan, excludeIds, platforms, count, releaseFilter, intent, references, webBudget);
      usingWeb = candidates.length > 0;
      usingWikidata = !steamOnly && candidates.some((candidate) => candidate.wikidata !== null);
    } catch (error) {
      // Web discovery is supplemental. A truncated/invalid LLM extraction or
      // provider failure must never take down the complete recommendation.
      console.warn("[recommend-agent] web discovery fallback:", error instanceof Error ? error.message : error);
      candidates = [];
    } finally {
      webMs = Date.now() - webStarted;
    }
  } else if (searchBudget.remaining > 0 && isGameBrainConfigured()) {
    gameBrainStatus = "ok";
    const gameBrainStarted = Date.now();
    try {
      candidates = await gatherGameBrainCandidates(plan, excludeIds, platforms, count, messages, releaseFilter, intent, strategy, actionReferences, searchBudget);
      usingGameBrain = candidates.length > 0;
    } catch (error) {
      if (!(error instanceof GameBrainUnavailableError || error instanceof GameBrainQuotaError)) throw error;
      gameBrainStatus = error instanceof GameBrainQuotaError ? "quota_exhausted" : "unavailable";
      console.warn("[recommend-agent] GameBrain fallback:", error instanceof Error ? error.message : error);
    } finally {
      gameBrainMs = Date.now() - gameBrainStarted;
    }
  } else if (isGameBrainConfigured() && searchBudget.remaining < 1) {
    gameBrainStatus = "budget_exhausted";
  }

  const eligibleCandidates = candidates.filter((candidate) => candidateMatchesIntent(candidate, intent)).length;
  const mobileOnly = platforms.length === 1 && platforms[0] === "mobile";
  if (eligibleCandidates < count && !mobileOnly) {
    const fallbackStarted = Date.now();
    const shouldVerifySteam = platforms.length === 0 || platforms.includes("steam");
    const fallback = preferSteam
      ? await gatherSteamCandidates(plan, excludeIds, STEAM_CANDIDATE_CAP, releaseFilter)
      : await gatherWikidataCandidates(plan, excludeIds, shouldVerifySteam, platforms, WIKIDATA_CANDIDATE_CAP, releaseFilter);
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

  return {
    candidates,
    usingGameBrain,
    usingWikidata,
    usingWeb,
    gameBrainStatus,
    gameBrainCandidates: candidates.filter((candidate) => candidate.gamebrain !== null).length,
    webCandidates: candidates.filter((candidate) => (candidate.webEvidence?.length ?? 0) > 0).length,
    timing: { totalMs: Date.now() - started, gameBrainMs, webMs, fallbackMs },
  };
}

function candidateMatchesIntent(candidate: Candidate, intent: RecommendationIntent): boolean {
  if (!matchesReleaseConstraint(candidateReleaseDate(candidate), intent.release)) return false;
  if (intent.price.freeOnly && !(candidate.gameBrainFiltersVerified || candidate.steam?.is_free)) return false;
  if (intent.price.maxUsd !== null && !intent.price.freeOnly && !candidate.gameBrainFiltersVerified) return false;
  if (intent.playModes.length > 0 && !candidate.gameBrainFiltersVerified) {
    const modes = candidatePlayerModes(candidate).join(" ").toLocaleLowerCase();
    if (intent.playModes.includes("co_op") && !/(?:co-?op|cooperative|\u5408\u4f5c)/i.test(modes)) return false;
    if (intent.playModes.includes("online_co_op") && !/(?:online|\u5728\u7ebf|\u8054\u673a)/i.test(modes)) return false;
    if (intent.playModes.includes("local_co_op") && !/(?:local|split|couch|\u672c\u5730|\u540c\u5c4f|\u5206\u5c4f)/i.test(modes)) return false;
    if (intent.playModes.includes("multiplayer") && !/(?:multi|\u591a\u4eba)/i.test(modes)) return false;
    if (intent.playModes.includes("single_player") && !/(?:single|\u5355\u4eba)/i.test(modes)) return false;
  }
  if (intent.mode !== "exact_lookup" || intent.referenceGames.length === 0) return true;
  const candidateName = normalizeGameName(candidate.name);
  return intent.referenceGames.some((reference) => {
    const target = normalizeGameName(reference);
    return candidateName === target || candidateName.includes(target) || target.includes(candidateName);
  });
}

function candidateMatchesSelectedPlatforms(candidate: Candidate, platforms: Platform[]): boolean {
  if (platforms.length === 0) return true;
  const names = candidatePlatforms(candidate);
  return platforms.some((platform) => {
    if (platform === "mobile") {
      const mobilePlatform = matchesPlatformFilter(names, ["mobile"]);
      return mobilePlatform && Boolean(candidate.gamebrain || (candidate.webOfficialUrl && isAllowedOfficialGameWebsite(candidate.webOfficialUrl)));
    }
    return matchesPlatformFilter(names, [platform], candidate.steamId !== null);
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
  favoriteGames: string[],
  onProgress?: ProgressReporter
): Promise<{
  candidates: Candidate[];
  usingGameBrain: boolean;
  usingWikidata: boolean;
  usingWeb: boolean;
  referenceProfiles: ReferenceGameProfile[];
  turns: number;
  gameBrainSearchTokens: number;
  webSearchRequests: number;
  timings: AgentTurnTiming[];
}> {
  const candidates: Candidate[] = [];
  const seenKeys = new Set<string>();
  const excludedKeys = new Set(excludeKeys);
  const history: AgentSearchRecord[] = [];
  const timings: AgentTurnTiming[] = [];
  let usingGameBrain = false;
  let usingWikidata = false;
  let usingWeb = false;
  let turns = 0;
  let agentDecisionDisabled = false;
  let activeReferenceProfiles = referenceProfiles;
  const favoriteReferences = uniqueTerms(favoriteGames, 2);
  // Similar costs one token per selected favorite. Reserve that amount from
  // the approximate five-token recommendation budget before allocating Search.
  const gameBrainSearchBudget: GameBrainSearchBudget = {
    remaining: Math.max(1, GAMEBRAIN_RECOMMENDATION_TOKEN_BUDGET - favoriteReferences.length),
    used: 0,
  };
  const webToolBudget: WebToolBudget = { remaining: isWebSearchConfigured() ? WEB_SEARCH_MAX_REQUESTS : 0, used: 0 };
  const maxTurns = MAX_AGENT_TURNS;

  const fallbackAction = (turn: number): RecommendationAgentAction => ({
    action: "search",
    strategy: deterministicFallbackStrategy(platforms, intent, activeReferenceProfiles, history, webToolBudget.remaining, gameBrainSearchBudget.remaining),
    ...deterministicAgentFallbackPlan(intent, activeReferenceProfiles, messages, releaseFilter, turn),
    references: intent.referenceGames,
    rationale: "agent decision unavailable; continue with a distinct deterministic tool plan based on current evidence and provider status",
  });

  for (let turn = 0; turn < maxTurns; turn++) {
    turns = turn + 1;
    const decisionStarted = Date.now();
    reportProgress(onProgress, "agent", "Planning next search", `Round ${turn + 1}/${maxTurns}: evaluating coverage and constraints.`);
    let action: RecommendationAgentAction;
    let decisionCacheHit = false;
    let actionType: AgentTurnTiming["action"] = "finalize";
    if (agentDecisionDisabled) {
      action = fallbackAction(turn);
      actionType = "fallback";
    } else {
      try {
        const decision = await decideRecommendationAgentAction(messages, platforms, count, previousGames, releaseFilter, candidates, history, turn, maxTurns, intent, activeReferenceProfiles, excludeKeys, webToolBudget.remaining);
        action = decision.action;
        decisionCacheHit = decision.cacheHit;
      } catch (error) {
        console.warn("[recommend-agent] decision fallback:", error instanceof Error ? error.message : error);
        if (candidates.length >= count) break;
        agentDecisionDisabled = true;
        action = fallbackAction(turn);
        actionType = "fallback";
      }
    }
    const companyMatchCount = intent.companies.length > 0
      ? candidates.filter((candidate) => matchesCompanyConstraint(candidate, intent.companies)).length
      : 0;
    const companyWebRequestsNeeded = platforms.includes("mobile") ? 2 : 1;
    if (
      action.action === "finalize"
      && intent.companies.length > 0
      && companyMatchCount < count
      && isWebSearchConfigured()
      && webToolBudget.remaining >= companyWebRequestsNeeded
    ) {
      action = {
        action: "search",
        strategy: "web",
        ...deterministicAgentFallbackPlan(intent, activeReferenceProfiles, messages, releaseFilter, turn),
        references: intent.referenceGames,
        rationale: `only ${companyMatchCount} candidates have verified evidence for the requested company preference; run a company-focused web search before finalizing`,
      };
    }
    if (action.action === "finalize" && candidates.length < count) {
      action = fallbackAction(turn);
      action.rationale = `only ${candidates.length} of ${count} requested candidates are available; continue with the best available verified data source`;
    }
    const decisionMs = Date.now() - decisionStarted;
    if (action.action === "search") {
      reportProgress(onProgress, "agent", "Search strategy selected", `Strategy: ${action.strategy ?? "catalog"}`);
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
      if (candidates.length >= minimumPool || turn === maxTurns - 1) break;
      continue;
    }

    const requestedStrategy: AgentSearchStrategy = action.strategy === "similar" || action.strategy === "franchise" || action.strategy === "newest" || action.strategy === "web" || action.strategy === "research" ? action.strategy : "catalog";
    const databaseStrategyUnavailable = gameBrainIsUnavailable(history);
    const webRequestsNeeded = platforms.includes("mobile") ? 2 : 1;
    const canUseWeb = isWebSearchConfigured() && webToolBudget.remaining >= webRequestsNeeded;
    const requestedDatabaseStrategy = requestedStrategy === "catalog" || requestedStrategy === "similar" || requestedStrategy === "franchise" || requestedStrategy === "newest";
    // Similar is reserved for games explicitly selected in the favorite-game UI.
    // Text-only references still inform the normal filtered Search query.
    const strategy: AgentSearchStrategy = favoriteReferences.length > 0 && turn === 0
      ? "similar"
      : requestedDatabaseStrategy && databaseStrategyUnavailable && canUseWeb ? "web"
      : requestedStrategy === "similar" ? "catalog"
        : requestedStrategy === "research" && webToolBudget.remaining < 1 ? "catalog"
        : requestedStrategy === "web" && !canUseWeb ? "catalog"
          : requestedStrategy;
    const actionReferences = strategy === "similar"
      ? favoriteReferences
      : strategy === "web" || strategy === "research"
        ? uniqueTerms([...favoriteReferences, ...intent.referenceGames, ...(action.references ?? [])], 2)
        : uniqueTerms(action.references ?? [], 2);
    const normalizedPlan = normalizeAgentPlan(action, messages, releaseFilter);
    const plan = strategy === "web" && intent.companies.length > 0 && platforms.length === 0
      ? {
          ...normalizedPlan,
          query: `${intent.companies.join(" ")} ${normalizedPlan.query.replace(/\bsteam\b/gi, " ")} PC console mobile`.replace(/\s+/g, " ").trim().slice(0, 180),
        }
      : normalizedPlan;
    if (history.some((record) => record.strategy === strategy && record.query.toLocaleLowerCase() === plan.query.toLocaleLowerCase())) {
      timings.push({ turn: turn + 1, action: actionType === "fallback" ? "fallback" : "search", decisionMs, decisionCacheHit, toolMs: 0, gameBrainMs: 0, fallbackMs: 0, candidateCount: candidates.length, added: 0, query: plan.query });
      if (candidates.length >= count) break;
      continue;
    }

    const toolStarted = Date.now();
    const executedQuery = strategy === "web"
      ? buildWebSearchQuery(plan, platforms, releaseFilter, intent, actionReferences)
      : plan.query;
    reportProgress(onProgress, "tool", "Querying game data sources", strategy === "web"
      ? `Searching the web with ${webSearchProvider() ?? "configured provider"}: ${executedQuery}`
      : strategy === "research"
        ? `Researching reference-game art direction and gameplay with ${webSearchProvider() ?? "configured provider"}: ${actionReferences.join(", ")}`
        : `Executing ${strategy} with GameBrain, Steam, and Wikidata: ${executedQuery}`);
    if (strategy === "research") {
      const researched = await researchReferenceProfiles(actionReferences, webToolBudget);
      activeReferenceProfiles = mergeReferenceProfileEvidence(activeReferenceProfiles, researched);
      usingWeb ||= researched.length > 0;
      const toolMs = Date.now() - toolStarted;
      reportProgress(onProgress, "tool", "Reference profile updated", `Added evidence-backed visual and gameplay traits for ${researched.length} reference games.`);
      history.push({ strategy, query: plan.query, references: actionReferences, added: 0, gameBrainCandidates: 0, gameBrainStatus: "not_used", webCandidates: 0, observedGames: [], rationale: action.rationale ?? "" });
      timings.push({ turn: turn + 1, action: "search", decisionMs, decisionCacheHit, toolMs, gameBrainMs: 0, webMs: toolMs, fallbackMs: 0, candidateCount: candidates.length, added: 0, query: plan.query });
      continue;
    }
    const result = await gatherAgentCandidates(plan, excludeIds, platforms, count, messages, releaseFilter, intent, strategy, actionReferences, gameBrainSearchBudget, webToolBudget);
    usingGameBrain ||= result.usingGameBrain;
    usingWikidata ||= result.usingWikidata;
    usingWeb ||= result.usingWeb;
    let added = 0;
    for (const candidate of result.candidates) {
      if (!candidateMatchesSelectedPlatforms(candidate, platforms)) continue;
      if (!candidateMatchesIntent(candidate, intent)) continue;
      if (excludedKeys.has(candidate.key) || seenKeys.has(candidate.key)) continue;
      seenKeys.add(candidate.key);
      candidates.push(candidate);
      added += 1;
      if (candidates.length >= RANK_POOL_CAP) break;
    }
    const gameBrainSummary = result.gameBrainStatus === "quota_exhausted"
      ? "GameBrain daily quota exhausted"
      : result.gameBrainStatus === "budget_exhausted"
        ? "GameBrain recommendation budget exhausted"
        : result.gameBrainStatus === "unavailable"
          ? "GameBrain unavailable"
          : result.gameBrainStatus === "not_used"
            ? "GameBrain not used in this round"
            : `GameBrain returned ${result.gameBrainCandidates}`;
    reportProgress(onProgress, "tool", "Candidate results received", `${gameBrainSummary}; web search contributed ${result.webCandidates}; added ${added} verified candidates.`);
    history.push({
      strategy,
      query: plan.query,
      references: actionReferences,
      added,
      gameBrainCandidates: result.gameBrainCandidates,
      gameBrainStatus: result.gameBrainStatus,
      webCandidates: result.webCandidates,
      observedGames: result.candidates.slice(0, 12).map((candidate) => ({ key: candidate.key, name: candidate.name, year: candidateReleaseDate(candidate), genre: candidateGenres(candidate).join(" / ") })),
      rationale: action.rationale ?? "",
    });
    timings.push({ turn: turn + 1, action: actionType === "fallback" ? "fallback" : "search", decisionMs, decisionCacheHit, toolMs: Date.now() - toolStarted, gameBrainMs: result.timing.gameBrainMs, webMs: result.timing.webMs, fallbackMs: result.timing.fallbackMs, candidateCount: candidates.length, added, query: plan.query });

    if (candidates.length >= RANK_POOL_CAP) break;
  }

  return { candidates, usingGameBrain, usingWikidata, usingWeb, referenceProfiles: activeReferenceProfiles, turns, gameBrainSearchTokens: gameBrainSearchBudget.used, webSearchRequests: webToolBudget.used, timings };
}

export async function recommend(messages: ChatMessage[], excludeIds: number[], platforms: Platform[] = [], count = 6, previousGames: PreviousRecommendation[] = [], releaseFilter: ReleaseFilter = "all", favoriteGames: string[] = [], excludeKeys: string[] = [], onProgress?: ProgressReporter): Promise<RecommendResponse> {
  const started = Date.now();
  const metricsBefore = {
    ai: aiUsageStats(),
    gamebrain: gameBrainCacheStats(),
    web: webSearchStats(),
    steam: steamCacheStats(),
    wikidata: wikidataCacheStats(),
  };
  let stageStarted = started;
  reportProgress(onProgress, "intent", "Parsing request", "Extracting reference games, companies, platforms, release constraints, and recency preferences.");
  const parsedIntent = parseRecommendationIntent(messages, favoriteGames, releaseFilter);
  const intent = await enrichRecommendationIntent(parsedIntent, messages);
  const effectivePlatforms = platforms.length > 0 ? platforms : intent.platforms;
  const intentMs = Date.now() - stageStarted;
  stageStarted = Date.now();
  reportProgress(onProgress, "intent", "Request parsed", `Found ${intent.referenceGames.length} reference games and ${intent.companies.length} company preferences.`);
  reportProgress(onProgress, "profile", "Building preference profile", "Resolving reference games through Suggest, Steam, and Wikidata.");
  const referenceProfiles = await analyzeReferenceGames(intent.referenceGames);
  const profileMs = Date.now() - stageStarted;
  stageStarted = Date.now();
  reportProgress(onProgress, "profile", "Preference profile ready", `Loaded genre and platform evidence for ${referenceProfiles.length} reference games.`);
  // New clients send source-qualified keys. Keep numeric exclusion only for
  // older persisted sessions so different providers cannot hide each other.
  const legacyExcludeIds = excludeKeys.length > 0 ? [] : excludeIds;
  const agent = await runRecommendationAgent(messages, legacyExcludeIds, effectivePlatforms, count, previousGames, releaseFilter, intent, referenceProfiles, excludeKeys, favoriteGames, onProgress);
  const candidateMs = Date.now() - stageStarted;
  stageStarted = Date.now();

  if (agent.candidates.length === 0) {
    if (previousGames.length > 0) {
      const reply = "本轮没有检索到满足补充条件的新游戏，已保留当前推荐列表。你可以调整画风、玩法、平台或发售时间后继续补充。";
      console.info(`[recommend] no-new-candidates previous=${previousGames.length} companies=${JSON.stringify(intent.companies)} gamebrainSearchTokens=${agent.gameBrainSearchTokens} webSearchRequests=${agent.webSearchRequests} total=${Date.now() - started}ms`);
      reportProgress(onProgress, "complete", "No new candidates", `Kept ${previousGames.length} existing recommendations because this round found no verified additions.`);
      return { reply, games: [] };
    }
    throw new Error("本轮数据源没有返回可验证的游戏候选。系统已自动尝试切换检索方式；请稍后重试，若持续出现请检查联网搜索或 AI 服务状态。");
  }

  reportProgress(onProgress, "filter", "Validating candidates", `Keeping ${agent.candidates.length} candidates that satisfy platform and release constraints; company names remain ranking preferences.`);
  const orderedCandidates = preRankCandidates(agent.candidates, agent.referenceProfiles, intent);
  const rankPool = orderedCandidates.slice(0, Math.min(orderedCandidates.length, Math.min(RANK_POOL_CAP, Math.max(count + 20, count * 3))));
  reportProgress(onProgress, "rank", "Ranking candidates", `Selecting ${count} recommendations from ${rankPool.length} candidates.`);
  const { reply, picks, cacheHit: rankCacheHit } = await pickAndRank(messages, rankPool, count, effectivePlatforms, previousGames, releaseFilter, intent, agent.referenceProfiles);
  const rankMs = Date.now() - stageStarted;
  stageStarted = Date.now();
  const candidateMap = new Map(orderedCandidates.map((candidate) => [candidate.key, candidate]));
  const pickedCandidates = picks.map((pick) => candidateMap.get(pick.key)).filter((candidate): candidate is Candidate => Boolean(candidate));
  reportProgress(onProgress, "enrich", "Enriching game details", "Loading reviews, cover art, pricing, and store links.");
  const steamIds = pickedCandidates.map((candidate) => candidate.steamId).filter((id): id is number => typeof id === "number");
  const wikiGames = pickedCandidates.map((candidate) => candidate.wikidata).filter((game): game is WikidataGame => Boolean(game));
  const [steamReviews, wikipedia, officialImages] = await Promise.all([
    getReviewSummaries(steamIds).catch(() => new Map<number, ReviewSummary>()),
    getWikipediaEnrichment(wikiGames).catch(() => new Map<number, WikipediaEnrichment>()),
    loadOfficialPageImages(pickedCandidates, effectivePlatforms).catch(() => new Map<string, string>()),
  ]);

  const games = picks.map((pick) => {
    const candidate = candidateMap.get(pick.key);
    if (!candidate) return null;
    return toGame(candidate, platformAwareRecommendationReason(pick.reason, candidate, effectivePlatforms), candidate.steamId ? steamReviews.get(candidate.steamId) : undefined, effectivePlatforms, wikipedia.get(candidate.id), officialImages.get(candidate.key));
  }).filter((game): game is Game => game !== null);

  const enrichMs = Date.now() - stageStarted;
  const metrics = {
    ai: diffAiUsage(metricsBefore.ai),
    gamebrain: metricDelta(metricsBefore.gamebrain, gameBrainCacheStats()),
    web: metricDelta(metricsBefore.web, webSearchStats()),
    steam: metricDelta(metricsBefore.steam, steamCacheStats()),
    wikidata: metricDelta(metricsBefore.wikidata, wikidataCacheStats()),
  };
  console.info(`[recommend] quality=${RECOMMEND_QUALITY} mode=${intent.mode} refs=${JSON.stringify(intent.referenceGames)} companies=${JSON.stringify(intent.companies)} release=${JSON.stringify(intent.release)} agentTurns=${agent.turns} gamebrainSearchTokens=${agent.gameBrainSearchTokens} webSearchRequests=${agent.webSearchRequests} intent=${intentMs}ms profile=${profileMs}ms candidates=${candidateMs}ms rank=${rankMs}ms enrich=${enrichMs}ms total=${Date.now() - started}ms gamebrain=${agent.usingGameBrain} web=${agent.usingWeb} wikidata=${agent.usingWikidata} platforms=${effectivePlatforms.join(",") || "any"} release=${releaseFilter} timings=${JSON.stringify(agent.timings)} llmCache=${JSON.stringify({ rankCacheHit, ...llmCacheStats() })} metrics=${JSON.stringify(metrics)}`);
  reportProgress(onProgress, "complete", "Recommendation complete", `Generated ${games.length} game recommendations.`);
  return { reply, games };
}
