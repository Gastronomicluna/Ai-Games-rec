// Recommendation pipeline: search planning -> verified RAWG/Steam candidates -> AI ranking -> enriched result data.

import { chatCompletion, extractJson } from "./ai";
import {
  getRawgGamesBatch,
  getRawgStoreLinksBatch,
  inferRawgPlayerModes,
  isRawgConfigured,
  rawgHasSteam,
  rawgPlatformNames,
  searchRawg,
  type RawgGameDetail,
  type RawgGameSummary,
  type RawgStoreLink,
} from "./rawg";
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
import type { ChatMessage, Game, Platform, RecommendResponse } from "./types";

const RAWG_CANDIDATE_CAP = 40;
const STEAM_CANDIDATE_CAP = 50;
const SEARCH_PLAN_CACHE_TTL = 15 * 60 * 1000;
const searchPlanCache = new Map<string, { t: number; plan: SearchPlan }>();

interface SearchPlan {
  titles: string[];
  keywords: string[];
}

interface Candidate {
  id: number;
  name: string;
  rawg: RawgGameSummary | null;
  steamId: number | null;
  steam: SteamAppData | null;
}

function transcript(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role === "user" ? "鐢ㄦ埛" : "鍔╂墜"}锛?{message.content}`).join("\n");
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

function searchPlanKey(messages: ChatMessage[]): string {
  return messages.filter((message) => message.role === "user").map((message) => message.content.trim()).join("\n");
}

function shouldMatchSteam(messages: ChatMessage[], platforms?: Platform[]): boolean {
  // Explicit platform selection overrides text-based detection
  if (platforms && platforms.length > 0) {
    return platforms.includes("steam");
  }
  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join(" ");
  return !/(nintendo|switch|playstation|\bps[345]\b|xbox|涓绘満鐙崰|鎵嬫父|鎵嬫満娓告垙|android|ios)/i.test(userText);
}

async function buildSearchPlan(messages: ChatMessage[]): Promise<SearchPlan> {
  const cacheKey = searchPlanKey(messages);
  const cached = searchPlanCache.get(cacheKey);
  if (cached && Date.now() - cached.t < SEARCH_PLAN_CACHE_TTL) return cached.plan;
  const system = `You plan searches for a Chinese game recommendation product backed by RAWG and Steam. Read the full conversation and propose real games likely to satisfy the user. Every title is verified through a real game API before recommendation, so never invent games.
Requirements:
- titles: 15-20 specific standalone full games, using their official English names whenever possible
- Prefer precise titles such as "It Takes Two" or "Portal 2", not abstract genre phrases
- Do not include demos, playtests, soundtracks, friend passes, dedicated servers, DLC, or companion apps
- Include multiple platforms when the user did not explicitly request PC only
- Cover varied prices, release years, popularity levels, and gameplay approaches while staying relevant
- If the user names a favorite game, focus on similar alternatives instead of merely repeating it
- keywords: 3-5 short genre, theme, or mechanic phrases for RAWG fallback search
- Output JSON only: {"titles":["..."],"keywords":["..."]}`;

  const output = await chatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: transcript(messages) },
    ],
    { maxTokens: 2200, temperature: 0.4, model: process.env.AI_FAST_MODEL }
  );

  const parsed = extractJson<{ titles?: unknown[]; keywords?: unknown[] }>(output);
  const titles = uniqueTerms(parsed.titles ?? [], 20);
  const keywords = uniqueTerms(parsed.keywords ?? [], 5);
  searchPlanCache.set(cacheKey, { t: Date.now(), plan: { titles, keywords } });
  return { titles, keywords };
}
function isLikelyStandaloneName(name: string): boolean {
  return !/(friend[?'s]* pass|demo|playtest|soundtrack|dedicated server|benchmark|artbook|companion|editor|test server)/i.test(name);
}

function isLikelyStandaloneSteamGame(app: SteamAppData): boolean {
  return app.type === "game" && Boolean(app.name && app.header_image) && isLikelyStandaloneName(app.name ?? "");
}


function addUniqueId(ids: number[], seen: Set<number>, excluded: Set<number>, id: number, cap: number) {
  if (ids.length >= cap || seen.has(id) || excluded.has(id)) return;
  seen.add(id);
  ids.push(id);
}

const PLATFORM_MAP: Record<Platform, RegExp> = {
  steam: /pc|windows/i,
  psn: /playstation/i,
  ns: /nintendo/i,
};

function matchesPlatformFilter(game: RawgGameSummary, platforms: Platform[]): boolean {
  if (platforms.length === 0) return true;
  const names = rawgPlatformNames(game).join(" ");
  return platforms.some((p) => PLATFORM_MAP[p].test(names));
}

async function gatherRawgCandidates(plan: SearchPlan, excludeIds: number[], includeSteam: boolean, platforms: Platform[], cap = 30): Promise<Candidate[]> {
  if (!isRawgConfigured()) return [];

  const searches = [
    ...plan.titles.map((term) => ({ term, count: 2 })),
    ...plan.keywords.map((term) => ({ term, count: 5 })),
  ];
  const resultSets = await Promise.all(searches.map((item) => searchRawg(item.term, item.count)));
  const excluded = new Set(excludeIds);
  const seen = new Set<number>();
  const ids: number[] = [];
  const summaryMap = new Map<number, RawgGameSummary>();
  for (const set of resultSets) for (const game of set) summaryMap.set(game.id, game);

  for (let index = 0; index < plan.titles.length; index++) {
    const first = resultSets[index]?.[0];
    if (first) addUniqueId(ids, seen, excluded, first.id, cap);
  }
  for (const set of resultSets) {
    for (const game of set) addUniqueId(ids, seen, excluded, game.id, cap);
  }

  const summaries = ids.map((id) => summaryMap.get(id)).filter((game): game is RawgGameSummary => Boolean(game?.name && isLikelyStandaloneName(game.name) && matchesPlatformFilter(game, platforms)));
  const steamSearches = includeSteam
    ? await Promise.all(summaries.map((game) => (rawgHasSteam(game) ? searchStore(game.name, 3) : Promise.resolve([]))))
    : summaries.map(() => []);
  const steamIds = steamSearches.map((set) => set[0]?.id).filter((id): id is number => typeof id === "number");
  const steamDetails = await getAppDataBatch(Array.from(new Set(steamIds)));

  return summaries.map((rawg, index) => {
    const possibleSteamId = steamSearches[index]?.[0]?.id ?? null;
    const steam = possibleSteamId ? steamDetails.get(possibleSteamId) ?? null : null;
    return {
      id: rawg.id,
      name: rawg.name,
      rawg,
      steamId: steam && isLikelyStandaloneSteamGame(steam) ? possibleSteamId : null,
      steam: steam && isLikelyStandaloneSteamGame(steam) ? steam : null,
    };
  });
}

async function gatherSteamCandidates(plan: SearchPlan, excludeIds: number[], cap = 40): Promise<Candidate[]> {
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
  for (const set of resultSets) {
    for (const result of set) addUniqueId(ids, seen, excluded, result.id, cap);
  }

  const details = await getAppDataBatch(ids);
  const candidates: Candidate[] = [];
  for (const id of ids) {
    const steam = details.get(id);
    if (!steam || !isLikelyStandaloneSteamGame(steam)) continue;
    candidates.push({ id, name: steam.name!, rawg: null, steamId: id, steam });
  }
  return candidates;

}


const RAWG_TAG_NOISE = /(steam achievements|full controller support|partial controller support|steam cloud|steam trading cards|steam-trading-cards|steam workshop|remote play|captions available|includes level editor|stats|leaderboards|family sharing)/i;

function rawgGameplayTags(game: RawgGameSummary | RawgGameDetail): string[] {
  return (game.tags ?? []).map((item) => item.name).filter((name) => !RAWG_TAG_NOISE.test(name));
}

function candidateGenres(candidate: Candidate): string[] {
  return candidate.rawg?.genres?.map((item) => item.name) ?? candidate.steam?.genres?.map((item) => item.description) ?? [];
}

function candidateTags(candidate: Candidate): string[] {
  return candidate.rawg ? rawgGameplayTags(candidate.rawg).slice(0, 10) : derivePlayerModes(candidate.steam ?? {});
}

function candidatePlayerModes(candidate: Candidate): string[] {
  if (candidate.steam) return derivePlayerModes(candidate.steam);
  return candidate.rawg ? inferRawgPlayerModes(candidate.rawg) : [];
}

function candidatePlatforms(candidate: Candidate): string[] {
  if (candidate.rawg) return rawgPlatformNames(candidate.rawg);
  const platforms = candidate.steam?.platforms;
  return [platforms?.windows ? "Windows" : "", platforms?.mac ? "macOS" : "", platforms?.linux ? "Linux" : ""].filter(Boolean);
}

async function pickAndRank(
  messages: ChatMessage[],
  candidates: Candidate[],
  count: number
): Promise<{ reply: string; picks: { id: number; reason: string }[] }> {
  const compact = candidates.map((candidate) => ({
    id: candidate.id,
    鍚嶇О: candidate.name,
    骞冲彴: candidatePlatforms(candidate).join(" / ") || "鏈煡",
    绫诲瀷: candidateGenres(candidate).join(" / "),
    标签: candidateTags(candidate).join(" / "),
    玩法: candidatePlayerModes(candidate).join(" / "),
    骞冲潎娓哥帺鏃堕暱: candidate.rawg?.playtime ? `${candidate.rawg.playtime} 灏忔椂` : "鏈煡",
    价格: candidate.steam?.is_free ? "免费" : candidate.steam?.price_overview?.final_formatted ?? "未知",
    璇勫垎: candidate.rawg?.rating ?? candidate.steam?.metacritic?.score ?? null,
    鍙戝敭: candidate.rawg?.released ?? candidate.steam?.release_date?.date ?? "鏈煡",
  }));

  const system = `浣犳槸涓€涓腑鏂囨父鎴忔帹鑽愪笓瀹躲€備綘鍙兘浠庝笅鏂圭湡瀹?API 鍊欓€夋父鎴忎腑鎸戦€夛紝涓ョ缂栭€犲€欓€変箣澶栫殑娓告垙鎴栦俊鎭€?瑙勫垯锛?- 鐢ㄦ埛鎸囧畾骞冲彴鍋忓ソ锛屼紭鍏堝尮閰嶅搴斿钩鍙扮殑娓告垙
- 鎸戦€夋渶绗﹀悎鐢ㄦ埛瀹屾暣瀵硅瘽闇€姹傜殑 ${count} 娆撅紝鎸夊尮閰嶅害浠庨珮鍒颁綆鎺掑簭
- 閲嶇偣鏍稿骞冲彴銆佸崟浜?澶氫汉/鍚堜綔鏂瑰紡銆侀鏉愩€佺帺娉曘€侀毦搴﹀拰浠锋牸闇€姹?- 姣忔鍐欎竴鍙?30-60 瀛楃殑涓枃鎺ㄨ崘鐞嗙敱锛屽苟涓烘瘡娆炬父鎴忔彁渚涗腑鏂囨樉绀哄悕绉帮紙displayName瀛楁锛岃嫢鑻辨枃鍚嶅凡鏄€氱敤绉板懠鍒欏彲鐣欑┖锛夛紝鍏蜂綋璇存槑瀹冧负浠€涔堝鍚堢敤鎴烽渶姹傦紝绂佹绌鸿瘽
- 鍊欓€夋槑纭笌闇€姹傚啿绐佹椂涓嶈閫夋嫨锛涘€欓€変笉瓒虫椂鍙互灏戜簬 ${count} 娆?- reply 鍙仛涓€涓ゅ彞鎬讳綋鎬荤粨锛屼笉瑕佹壙璇哄叿浣撴帹鑽愭暟閲?- 鍙緭鍑?JSON锛歿"reply":"...","picks":[{"id":鏁板瓧,"reason":"..."}]}`;

  const output = await chatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: `鐢ㄦ埛瀵硅瘽锛歕n${transcript(messages)}\n\n鍊欓€夋父鎴忥細\n${JSON.stringify(compact)}` },
    ],
    { maxTokens: Math.max(4000, count * 800), temperature: 0.6 }
  );

  const parsed = extractJson<{ reply?: string; picks?: { id: number; reason: string }[] }>(output);
  const validIds = new Set(candidates.map((candidate) => candidate.id));
  const seen = new Set<number>();
  const picks = (parsed.picks ?? [])
    .filter((pick) => {
      if (!validIds.has(pick.id) || typeof pick.reason !== "string" || seen.has(pick.id)) return false;
      seen.add(pick.id);
      return true;
    })
        .slice(0, count);
  if (picks.length === 0) {
    console.error("[pickAndRank] parsed.picks count:", (parsed.picks ?? []).length, "validIds count:", validIds.size);
    console.error("[pickAndRank] parsed.picks:", JSON.stringify((parsed.picks ?? []).slice(0, 3)));
    console.error("[pickAndRank] sample validIds:", JSON.stringify([...validIds].slice(0, 5)));
    throw new Error("AI 未能从真实候选中选出游戏，请换个说法重试");
  }
  return { reply: parsed.reply?.trim() || "为你找到这些游戏：", picks };
}


function imageProxyUrl(url: string | null | undefined): string {
  if (!url) return "";
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

function pickHeaderImage(steamImage: string | null | undefined, rawgBg: string | null | undefined): string {
  // Steam CDN is accessible in China; prefer it when available
  if (steamImage) return steamImage;
  // RAWG media CDN (media.rawg.io) often blocked in China; proxy through our server
  if (rawgBg) return `/api/image-proxy?url=${encodeURIComponent(rawgBg)}`;
  return "";
}

function reviewFromSteam(summary: ReviewSummary | undefined): Game["review"] {
  if (!summary || summary.total_reviews <= 0) return null;
  const positiveRate = Math.round((summary.total_positive / summary.total_reviews) * 100);
  return { label: reviewLabel(positiveRate, summary.total_reviews), positiveRate, total: summary.total_reviews, source: "steam" };
}

function reviewFromRawg(game: RawgGameSummary | null): Game["review"] {
  if (!game?.rating) return null;
  const positiveRate = Math.min(100, Math.round((game.rating / 5) * 100));
  return {
    label: `RAWG ${game.rating.toFixed(1)}/5`,
    positiveRate,
    total: game.ratings_count ?? 0,
    source: "rawg",
  };
}

function formatReleaseDate(value?: string | null): string {
  if (!value) return "未知";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`;
  return value;
}
function selectStoreUrl(candidate: Candidate, links: RawgStoreLink[]): { url: string; name: string } {
  if (candidate.steamId) return { url: `https://store.steampowered.com/app/${candidate.steamId}`, name: "Steam Store" };
  const preferred = links.find((link) => link.store_id === 1) ?? links[0];
  if (preferred?.url) return { url: preferred.url, name: "View in Store" };
  if (candidate.rawg) return { url: `https://rawg.io/games/${candidate.rawg.slug}`, name: "RAWG Page" };
  return { url: "https://store.steampowered.com", name: "Steam Store" };
}

function toGame(
  candidate: Candidate,
  reason: string,
  detail: RawgGameDetail | null,
  reviewSummary: ReviewSummary | undefined,
  storeLinks: RawgStoreLink[]
): Game {
  const rawg = detail ?? candidate.rawg;
  const steam = candidate.steam;
  const platformNames = rawg ? rawgPlatformNames(rawg) : candidatePlatforms(candidate);
  const playerModes = steam ? derivePlayerModes(steam) : rawg ? inferRawgPlayerModes(rawg) : [];
  const genres = rawg?.genres?.map((item) => item.name) ?? steam?.genres?.map((item) => item.description) ?? [];
  const rawgTags = rawg ? rawgGameplayTags(rawg).filter((tag) => !genres.includes(tag)) : [];
  const tags = Array.from(new Set([...rawgTags, ...genres, ...playerModes])).slice(0, 8);
  const store = selectStoreUrl(candidate, storeLinks);
  const released = rawg?.released ?? steam?.release_date?.date;
  const steamReview = reviewFromSteam(reviewSummary);

  return {
    id: candidate.id,
    source: rawg ? "rawg" : "steam",
    steamAppId: candidate.steamId,
    name: steam?.name ?? rawg?.name ?? candidate.name,
    headerImage: pickHeaderImage(steam?.header_image, rawg?.background_image),
    shortDescription: (steam?.short_description ?? detail?.description_raw ?? "").replace(/\s+/g, " ").trim(),
    reason,
    genres,
    tags,
    playerModes,
    platformNames,
    price: {
      formatted: steam?.is_free ? "免费" : steam?.price_overview?.final_formatted ?? "暂无价格",
      finalCny: steam?.is_free ? 0 : steam?.price_overview ? steam.price_overview.final / 100 : null,
      discountPercent: steam?.price_overview?.discount_percent ?? 0,
    },
    releaseDate: formatReleaseDate(released),
    releaseTimestamp: rawg?.released
      ? Number.isNaN(Date.parse(rawg.released))
        ? null
        : Date.parse(rawg.released)
      : parseReleaseTimestamp(steam?.release_date?.date),
    developers: detail?.developers?.map((item) => item.name) ?? steam?.developers ?? [],
    publishers: detail?.publishers?.map((item) => item.name) ?? steam?.publishers ?? [],
    platforms: {
      windows: platformNames.some((name) => /pc|windows/i.test(name)),
      mac: platformNames.some((name) => /mac/i.test(name)),
      linux: platformNames.some((name) => /linux/i.test(name)),
    },
    metacritic: rawg?.metacritic ?? steam?.metacritic?.score ?? null,
    review: steamReview ?? reviewFromRawg(rawg ?? null),
    playtimeHours: rawg?.playtime && rawg.playtime > 0 ? rawg.playtime : null,
    storeUrl: store.url,
    storeName: store.name,
  };
}

export async function recommend(messages: ChatMessage[], excludeIds: number[], platforms: Platform[] = [], count = 6): Promise<RecommendResponse> {
  const started = Date.now();
  let stageStarted = started;
  const includeSteam = shouldMatchSteam(messages, platforms);
  const plan = await buildSearchPlan(messages);
  const planMs = Date.now() - stageStarted;
  stageStarted = Date.now();
  let candidates = await gatherRawgCandidates(plan, excludeIds, includeSteam, platforms, 40);
  let usingRawg = candidates.length > 0;

  if (candidates.length === 0) {
      candidates = await gatherSteamCandidates(plan, excludeIds, 50);
    usingRawg = false;
  }

  if (candidates.length < 4 && excludeIds.length > 0) {
    const relaxed = excludeIds.slice(0, Math.floor(excludeIds.length / 2));
    candidates = usingRawg ? await gatherRawgCandidates(plan, relaxed, includeSteam, platforms, 40) : await gatherSteamCandidates(plan, relaxed, 50);
  }
  if (candidates.length === 0) throw new Error("真实游戏库中没有检索到相关游戏，请换个描述重试");
  const candidateMs = Date.now() - stageStarted;
  stageStarted = Date.now();

  const { reply, picks } = await pickAndRank(messages, candidates, count);
  const rankMs = Date.now() - stageStarted;
  stageStarted = Date.now();
  const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const pickedCandidates = picks.map((pick) => candidateMap.get(pick.id)).filter((candidate): candidate is Candidate => Boolean(candidate));
  const rawgIds = pickedCandidates.filter((candidate) => candidate.rawg).map((candidate) => candidate.id);
  const steamIds = pickedCandidates.map((candidate) => candidate.steamId).filter((id): id is number => typeof id === "number");

  const [rawgDetails, rawgStoreLinks, steamReviews] = await Promise.all([
    getRawgGamesBatch(rawgIds),
    getRawgStoreLinksBatch(rawgIds),
    getReviewSummaries(steamIds),
  ]);

  const games = picks
    .map((pick) => {
      const candidate = candidateMap.get(pick.id);
      if (!candidate) return null;
      return toGame(
        candidate,
        pick.reason,
        rawgDetails.get(candidate.id) ?? null,
        candidate.steamId ? steamReviews.get(candidate.steamId) : undefined,
        rawgStoreLinks.get(candidate.id) ?? []
      );
    })
    .filter((game): game is Game => game !== null);

  const enrichMs = Date.now() - stageStarted;
  console.info(`[recommend] timing plan=${planMs}ms candidates=${candidateMs}ms rank=${rankMs}ms enrich=${enrichMs}ms total=${Date.now() - started}ms rawg=${usingRawg} steamMatch=${includeSteam}`);
  return { reply, games };
}
