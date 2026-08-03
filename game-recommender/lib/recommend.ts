// Recommendation pipeline: search planning -> verified Wikidata/Steam candidates -> AI ranking -> enriched result data.

import { chatCompletionJson } from "./ai";
import { getSimilarGameBrain, searchGameBrain, isGameBrainConfigured, type GameBrainGame, GameBrainQuotaError, GameBrainUnavailableError } from "./gamebrain";
import { matchesPlatformFilter, platformPreferenceText, releaseFilterText, searchPlanKey, transcript, matchesReleaseFilter } from "./recommend-preferences";
import {
  getWikipediaEnrichment,
  searchWikidataBatch,
  wikidataPageUrl,
  type WikidataGame,
  type WikipediaEnrichment,
} from "./wikidata";
import {
  derivePlayerModes,
  getAppDataBatch,
  getReviewSummaries,
  parseReleaseTimestamp,
  reviewLabel,
  searchStore,
  type ReviewSummary,
  type SteamAppData,
} from "./steam";
import type { ChatMessage, Game, Platform, PreviousRecommendation, RecommendResponse, ReleaseFilter } from "./types";

const WIKIDATA_CANDIDATE_CAP = 40;
const STEAM_CANDIDATE_CAP = 50;
const SEARCH_PLAN_CACHE_TTL = 15 * 60 * 1000;
const searchPlanCache = new Map<string, { t: number; plan: SearchPlan }>();

interface SearchPlan {
  query: string;
  titles: string[];
  keywords: string[];
}

interface Candidate {
  id: number;
  name: string;
  gamebrain: GameBrainGame | null;
  wikidata: WikidataGame | null;
  steamId: number | null;
  steam: SteamAppData | null;
  matchedPlatformNames: string[];
  similarToReference: boolean;
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
    const releaseHint = releaseFilter === "last1" ? " released 2025 or newer" : releaseFilter === "last3" ? " released 2023 or newer" : releaseFilter === "last5" ? " released 2021 or newer" : releaseFilter === "before2020" ? " released before 2020" : releaseFilter === "before2010" ? " released before 2010" : "";
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
  return name.normalize("NFKD").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
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

function addUniqueId(ids: number[], seen: Set<number>, excluded: Set<number>, id: number, cap: number) {
  if (ids.length >= cap || seen.has(id) || excluded.has(id)) return;
  seen.add(id);
  ids.push(id);
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

function referenceGameNames(messages: ChatMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const match of message.content.matchAll(/《([^》]{1,80})》/g)) {
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
  releaseFilter: ReleaseFilter
): Promise<Candidate[]> {
  const target = Math.min(40, Math.max(count + 10, count * 2));
  const platformKeys = Array.from(new Set(platforms.flatMap((platform) => GAMEBRAIN_PLATFORM_KEYS[platform])));
  const references = referenceGameNames(messages);
  const referenceKeys = new Set(references.map((name) => normalizeGameName(name)));
  const releaseHint = releaseFilter === "last1" ? " released 2025 or newer" : releaseFilter === "last3" ? " released 2023 or newer" : releaseFilter === "last5" ? " released 2021 or newer" : releaseFilter === "before2020" ? " released before 2020" : releaseFilter === "before2010" ? " released before 2010" : "";
  const naturalQuery = (plan.query.replace(/Nintendo Switch|PlayStation|Steam|Windows|PC/gi, " ").replace(/\s+/g, " ").trim() + releaseHint).trim();
  const queries = references.length > 0
    ? [references.join(" "), ...(naturalQuery && normalizeGameName(naturalQuery) !== normalizeGameName(references.join(" ")) ? [naturalQuery] : [])]
    : [naturalQuery || plan.query];
  const branchTarget = Math.min(20, Math.ceil(target / queries.length) + 5);
  const games: GameBrainGame[] = [];
  const similarIds = new Set<number>();
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const branchGames = await searchGameBrain(queries[queryIndex], platformKeys, branchTarget);
    games.push(...branchGames);
    if (queryIndex === 0 && references.length > 0) {
      const seed = branchGames.find((game) => normalizeGameName(game.name) === normalizeGameName(references[0]));
      if (seed) {
        try {
          for (const similar of await getSimilarGameBrain(seed.id, 10)) similarIds.add(similar.id);
        } catch (error) {
          if (!(error instanceof GameBrainUnavailableError || error instanceof GameBrainQuotaError)) throw error;
          console.warn("[recommend] Similar Games fallback:", error instanceof Error ? error.message : error);
        }
      }
    }
  }
  const uniqueGames = new Map<number, GameBrainGame>();
  for (const game of games) if (!uniqueGames.has(game.id)) uniqueGames.set(game.id, game);
  const mergedGames = Array.from(uniqueGames.values()).sort((a, b) => Number(similarIds.has(b.id)) - Number(similarIds.has(a.id)));
  const excluded = new Set(excludeIds);
  const filtered = mergedGames.filter((game) => !excluded.has(game.id) && isLikelyStandaloneName(game.name) && matchesReleaseFilter(game.year, releaseFilter) && !referenceKeys.has(normalizeGameName(game.name)));
  const shouldVerifySteam = platforms.length === 0 || platforms.includes("steam");
  const steamSearches = shouldVerifySteam
    ? await Promise.all(filtered.map((game) => searchStore(game.name, 3)))
    : filtered.map(() => []);
  const possibleSteamIds = filtered.map((game, index) => pickSteamSearchMatch(game.name, steamSearches[index] ?? []));
  const steamDetails = await getAppDataBatch(possibleSteamIds.filter((id): id is number => id !== null));
  const matchedPlatformNames = platforms.map((platform) => PLATFORM_DISPLAY_NAMES[platform]);

  return filtered
    .map((game, index): Candidate => {
      const possibleSteamId = possibleSteamIds[index];
      const steam = possibleSteamId ? steamDetails.get(possibleSteamId) ?? null : null;
      const validSteam = steam && isLikelyStandaloneSteamGame(steam) ? steam : null;
      return {
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
  const searches = plan.titles.map((query) => ({ query, limit: 3 }));
  const resultSets = await searchWikidataBatch(searches);
  const excluded = new Set(excludeIds);
  const seen = new Set<number>();
  const ids: number[] = [];
  const gameMap = new Map<number, WikidataGame>();
  for (const set of resultSets) for (const game of set) gameMap.set(game.id, game);

  for (let index = 0; index < plan.titles.length; index++) {
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
  const steamIds = steamSearches.map((set) => set[0]?.id).filter((id): id is number => typeof id === "number");
  const steamDetails = await getAppDataBatch(Array.from(new Set(steamIds)));

  return games
    .map((wikidata, index): Candidate => {
      const possibleSteamId = pickSteamSearchMatch(wikidata.name, steamSearches[index] ?? []);
      const steam = possibleSteamId ? steamDetails.get(possibleSteamId) ?? null : null;
      const validSteam = steam && isLikelyStandaloneSteamGame(steam) ? steam : null;
      return { id: wikidata.id, name: wikidata.name, gamebrain: null, wikidata, steamId: validSteam ? possibleSteamId : null, steam: validSteam, matchedPlatformNames: wikidata.platforms, similarToReference: false };
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
    candidates.push({ id, name: steam.name!, gamebrain: null, wikidata: null, steamId: id, steam, matchedPlatformNames: [], similarToReference: false });
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

async function pickAndRank(messages: ChatMessage[], candidates: Candidate[], count: number, platforms: Platform[], previousGames: PreviousRecommendation[], releaseFilter: ReleaseFilter): Promise<{ reply: string; picks: { id: number; reason: string }[] }> {
  const targetCount = Math.min(count, candidates.length);
  const aiPickCount = targetCount;
  const compact = candidates.map((candidate) => ({
    id: candidate.id,
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
- 用户选择的平台为硬约束。当前平台偏好：${platformPreferenceText(platforms)}\n- 发售时间偏好：${releaseFilterText(releaseFilter)}
- 挑选匹配度最高的恰好 ${aiPickCount} 款，按匹配度从高到低排序；剩余结果由系统按数据库相关度补齐
- 重点核对平台、单人/多人方式、题材、玩法、难度和价格
- 每款写一句具体的中文推荐理由
- 只输出 JSON：{"reply":"...","picks":[{"id":数字,"reason":"..."}]}`;
  const parsed = await chatCompletionJson<{ reply?: string; picks?: { id: number; reason: string }[] }>(
    [
      { role: "system", content: system },
      { role: "user", content: `用户对话：\n${transcript(messages)}\n\n上一批推荐（用户可能希望在此基础上修正）：\n${JSON.stringify(previousGames)}\n\n真实候选游戏：\n${JSON.stringify(compact)}` },
    ],
    { maxTokens: Math.min(9000, Math.max(5000, aiPickCount * 400)), temperature: 0.35 }
  );
  const validIds = new Set(candidates.map((candidate) => candidate.id));
  const seen = new Set<number>();
  const picks = (parsed.picks ?? []).filter((pick) => {
    if (!validIds.has(pick.id) || typeof pick.reason !== "string" || seen.has(pick.id)) return false;
    seen.add(pick.id);
    return true;
  }).slice(0, aiPickCount);
  for (const candidate of candidates) {
    if (picks.length >= targetCount) break;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const genre = candidateGenres(candidate).slice(0, 2).join("、") || "玩法";
    picks.push({ id: candidate.id, reason: `支持${platformPreferenceText(platforms)}，以${genre}为核心，可作为符合当前偏好的补充选择。` });
  }
  if (picks.length === 0) throw new Error("AI 未能从真实候选中选出游戏，请换个说法重试");
  return { reply: parsed.reply?.trim() || "为你找到这些游戏：", picks };
}

function imageProxyUrl(url?: string): string {
  return url ? `/api/image-proxy?url=${encodeURIComponent(url)}` : "";
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
    headerImage: (candidate.gamebrain?.image ?? steam?.header_image ?? imageProxyUrl(enrichment?.imageUrl ?? wiki?.imageUrl)) || `/api/game-placeholder?name=${encodeURIComponent(candidate.name)}`,
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

export async function recommend(messages: ChatMessage[], excludeIds: number[], platforms: Platform[] = [], count = 6, previousGames: PreviousRecommendation[] = [], releaseFilter: ReleaseFilter = "all"): Promise<RecommendResponse> {
  const started = Date.now();
  let stageStarted = started;
  const includeSteam = true;
  const steamOnly = platforms.length === 1 && platforms[0] === "steam";
  const plan = await buildSearchPlan(messages, platforms, previousGames, releaseFilter);
  const planMs = Date.now() - stageStarted;
  stageStarted = Date.now();

  let candidates: Candidate[] = [];
  let usingGameBrain = false;
  let usingWikidata = false;
  if (isGameBrainConfigured()) {
    try {
      candidates = await gatherGameBrainCandidates(plan, excludeIds, platforms, count, messages, releaseFilter);
      usingGameBrain = candidates.length > 0;
    } catch (error) {
      if (!(error instanceof GameBrainUnavailableError || error instanceof GameBrainQuotaError)) throw error;
      console.warn("[recommend] GameBrain fallback:", error.message);
    }
  }

  if (candidates.length < count) {
    const fallback = steamOnly
      ? await gatherSteamCandidates(plan, excludeIds, STEAM_CANDIDATE_CAP, releaseFilter)
      : await gatherWikidataCandidates(plan, excludeIds, includeSteam, platforms, WIKIDATA_CANDIDATE_CAP, releaseFilter);
    const seenCandidateIds = new Set(candidates.map((candidate) => candidate.id));
    for (const candidate of fallback) {
      if (!seenCandidateIds.has(candidate.id)) candidates.push(candidate);
      if (candidates.length >= Math.max(count, 30)) break;
    }
    usingWikidata = !steamOnly && fallback.length > 0;
  }

  if (candidates.length === 0) throw new Error("真实游戏库中没有检索到相关游戏，请换个描述重试");
  const candidateMs = Date.now() - stageStarted;
  stageStarted = Date.now();

  const rankPool = candidates.slice(0, Math.min(candidates.length, Math.max(count + 10, count)));
  const { reply, picks } = await pickAndRank(messages, rankPool, count, platforms, previousGames, releaseFilter);
  const rankMs = Date.now() - stageStarted;
  stageStarted = Date.now();
  const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const pickedCandidates = picks.map((pick) => candidateMap.get(pick.id)).filter((candidate): candidate is Candidate => Boolean(candidate));
  const steamIds = pickedCandidates.map((candidate) => candidate.steamId).filter((id): id is number => typeof id === "number");
  const wikiGames = pickedCandidates.map((candidate) => candidate.wikidata).filter((game): game is WikidataGame => Boolean(game));
  const [steamReviews, wikipedia] = await Promise.all([getReviewSummaries(steamIds), getWikipediaEnrichment(wikiGames)]);

  const games = picks.map((pick) => {
    const candidate = candidateMap.get(pick.id);
    if (!candidate) return null;
    return toGame(candidate, pick.reason, candidate.steamId ? steamReviews.get(candidate.steamId) : undefined, platforms, wikipedia.get(candidate.id));
  }).filter((game): game is Game => game !== null);

  const enrichMs = Date.now() - stageStarted;
  console.info(`[recommend] timing plan=${planMs}ms candidates=${candidateMs}ms rank=${rankMs}ms enrich=${enrichMs}ms total=${Date.now() - started}ms gamebrain=${usingGameBrain} wikidata=${usingWikidata} platforms=${platforms.join(",") || "any"} release=${releaseFilter}`);
  return { reply, games };
}
