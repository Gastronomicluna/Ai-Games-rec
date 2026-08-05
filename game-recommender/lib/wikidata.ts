// Wikidata + Wikipedia game catalog client. No API key or account is required.

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const CACHE_TTL = 30 * 60 * 1000;
const USER_AGENT = "WanShenMe/1.0 (game recommendation project)";
const cache = new Map<string, { t: number; data: unknown }>();
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

export interface WikidataCacheStats {
  hits: number;
  misses: number;
  networkRequests: number;
  failures: number;
}

const cacheStats: WikidataCacheStats = { hits: 0, misses: 0, networkRequests: 0, failures: 0 };

export function wikidataCacheStats(): WikidataCacheStats {
  return { ...cacheStats };
}

export class WikidataUnavailableError extends Error {
  constructor(message = "Wikidata 游戏库当前不可用") {
    super(message);
    this.name = "WikidataUnavailableError";
  }
}

interface SearchEntity {
  id: string;
  label?: string;
  description?: string;
}

interface EntityValue {
  id?: string;
  time?: string;
}

interface Claim {
  mainsnak?: { datavalue?: { value?: EntityValue | string } };
  rank?: string;
}

interface EntityData {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, { title: string }>;
  missing?: string;
}

interface WikidataResponse {
  search?: SearchEntity[];
  entities?: Record<string, EntityData>;
  query?: {
    pages?: Record<string, {
      title: string;
      extract?: string;
      thumbnail?: { source?: string };
    }>;
  };
}

export interface WikidataGame {
  id: number;
  qid: string;
  name: string;
  description: string;
  releaseDate?: string;
  releaseTimestamp?: number;
  platforms: string[];
  genres: string[];
  gameModes: string[];
  developers: string[];
  publishers: string[];
  imageUrl?: string;
  officialWebsites: string[];
  wikipedia?: { site: "zh" | "en"; title: string };
}

export interface WikidataSearchRequest {
  query: string;
  limit: number;
}

export interface WikipediaEnrichment {
  summary?: string;
  imageUrl?: string;
}

async function waitForRateSlot(): Promise<void> {
  const current = requestQueue.then(async () => {
    const waitMs = Math.max(0, 800 - (Date.now() - lastRequestAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestAt = Date.now();
  });
  requestQueue = current.catch(() => undefined);
  await current;
}

async function fetchJson<T>(url: string, timeoutMs = 15_000, retries = 2): Promise<T> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.t < CACHE_TTL) {
    cacheStats.hits += 1;
    return cached.data as T;
  }
  cacheStats.misses += 1;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForRateSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      cacheStats.networkRequests += 1;
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: controller.signal,
      });
      if (response.status === 429 && attempt < retries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1000 : 1200 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new WikidataUnavailableError(`Wikidata API 错误 ${response.status}`);
      const data = (await response.json()) as T;
      cache.set(url, { t: Date.now(), data });
      return data;
    } catch (error) {
      cacheStats.failures += 1;
      if (error instanceof WikidataUnavailableError) throw error;
      if (attempt === retries) throw new WikidataUnavailableError("Wikidata API 请求超时或网络不可用");
    } finally {
      clearTimeout(timer);
    }
  }
  throw new WikidataUnavailableError();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      output[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return output;
}

function isLikelyGameResult(result: SearchEntity): boolean {
  const description = result.description ?? "";
  if (/(series|character|soundtrack|downloadable content|expansion pack|game engine)/i.test(description)) return false;
  return /(video game|computer game|arcade game|visual novel|interactive fiction|mobile game)/i.test(description);
}

async function searchEntities(query: string, count: number): Promise<SearchEntity[]> {
  const params = new URLSearchParams({
    action: "wbsearchentities",
    search: query,
    language: "en",
    uselang: "en",
    type: "item",
    limit: String(Math.max(10, Math.min(20, count * 4))),
    format: "json",
    origin: "*",
  });
  const data = await fetchJson<WikidataResponse>(`${WIKIDATA_API}?${params.toString()}`);
  return (data.search ?? []).filter(isLikelyGameResult).slice(0, count);
}

async function fetchEntities(ids: string[]): Promise<Map<string, EntityData>> {
  const output = new Map<string, EntityData>();
  for (let offset = 0; offset < ids.length; offset += 50) {
    const chunk = ids.slice(offset, offset + 50);
    const params = new URLSearchParams({
      action: "wbgetentities",
      ids: chunk.join("|"),
      props: "labels|descriptions|claims|sitelinks",
      languages: "en|zh|zh-cn",
      languagefallback: "1",
      format: "json",
      origin: "*",
    });
    const data = await fetchJson<WikidataResponse>(`${WIKIDATA_API}?${params.toString()}`);
    for (const [id, entity] of Object.entries(data.entities ?? {})) {
      if (!entity.missing) output.set(id, entity);
    }
  }
  return output;
}

function claimValues(entity: EntityData, property: string): (EntityValue | string)[] {
  return (entity.claims?.[property] ?? [])
    .filter((claim) => claim.rank !== "deprecated")
    .map((claim) => claim.mainsnak?.datavalue?.value)
    .filter((value): value is EntityValue | string => value !== undefined);
}

function claimEntityIds(entity: EntityData, property: string): string[] {
  return claimValues(entity, property)
    .map((value) => (typeof value === "object" ? value.id : undefined))
    .filter((value): value is string => Boolean(value));
}

function claimStrings(entity: EntityData, property: string): string[] {
  return claimValues(entity, property).filter((value): value is string => typeof value === "string");
}

function labelFor(entity: EntityData | undefined): string | undefined {
  return entity?.labels?.en?.value ?? entity?.labels?.["zh-cn"]?.value ?? entity?.labels?.zh?.value;
}

function parseWikidataTime(value: string): { date: string; timestamp: number } | null {
  const match = value.match(/^\+?(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const timestamp = Date.parse(date);
  return Number.isNaN(timestamp) ? null : { date, timestamp };
}

function commonsImageUrl(filename: string): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=900`;
}

function buildGame(entity: EntityData, labels: Map<string, EntityData>): WikidataGame | null {
  const name = labelFor(entity);
  if (!name || !/^Q\d+$/.test(entity.id)) return null;
  const releaseDates = claimValues(entity, "P577")
    .map((value) => (typeof value === "object" && value.time ? parseWikidataTime(value.time) : null))
    .filter((value): value is { date: string; timestamp: number } => Boolean(value))
    .sort((a, b) => a.timestamp - b.timestamp);
  const namesFor = (property: string) => Array.from(new Set(claimEntityIds(entity, property).map((id) => labelFor(labels.get(id))).filter((value): value is string => Boolean(value))));
  const instanceTypes = namesFor("P31");
  if (instanceTypes.some((type) => /(downloadable content|expansion pack|video game expansion|add-on|soundtrack)/i.test(type))) return null;
  const image = claimStrings(entity, "P18")[0];
  const zhWiki = entity.sitelinks?.zhwiki?.title;
  const enWiki = entity.sitelinks?.enwiki?.title;
  return {
    id: Number(entity.id.slice(1)),
    qid: entity.id,
    name,
    description: entity.descriptions?.["zh-cn"]?.value ?? entity.descriptions?.zh?.value ?? entity.descriptions?.en?.value ?? "",
    releaseDate: releaseDates[0]?.date,
    releaseTimestamp: releaseDates[0]?.timestamp,
    platforms: namesFor("P400"),
    genres: namesFor("P136"),
    gameModes: namesFor("P404"),
    developers: namesFor("P178"),
    publishers: namesFor("P123"),
    imageUrl: image ? commonsImageUrl(image) : undefined,
    officialWebsites: claimStrings(entity, "P856"),
    wikipedia: zhWiki ? { site: "zh", title: zhWiki } : enWiki ? { site: "en", title: enWiki } : undefined,
  };
}

export async function searchWikidataBatch(requests: WikidataSearchRequest[]): Promise<WikidataGame[][]> {
  if (requests.length === 0) return [];
  const searchResults = await mapLimit(requests, 4, (request) => searchEntities(request.query, request.limit));
  const ids = Array.from(new Set(searchResults.flat().map((result) => result.id)));
  const entities = await fetchEntities(ids);
  const referencedIds = new Set<string>();
  for (const entity of entities.values()) {
    for (const property of ["P31", "P400", "P136", "P404", "P178", "P123"]) {
      for (const id of claimEntityIds(entity, property)) referencedIds.add(id);
    }
  }
  const labels = await fetchEntities(Array.from(referencedIds));
  return searchResults.map((results) =>
    results.map((result) => buildGame(entities.get(result.id)!, labels)).filter((game): game is WikidataGame => Boolean(game))
  );
}

export async function searchWikidata(query: string, count = 8): Promise<WikidataGame[]> {
  return (await searchWikidataBatch([{ query, limit: count }]))[0] ?? [];
}

export async function getWikipediaEnrichment(games: WikidataGame[]): Promise<Map<number, WikipediaEnrichment>> {
  const output = new Map<number, WikipediaEnrichment>();
  for (const site of ["zh", "en"] as const) {
    const selected = games.filter((game) => game.wikipedia?.site === site);
    if (selected.length === 0) continue;
    const titleToId = new Map(selected.map((game) => [game.wikipedia!.title.toLocaleLowerCase(), game.id]));
    const params = new URLSearchParams({
      action: "query",
      prop: "extracts|pageimages",
      titles: selected.map((game) => game.wikipedia!.title).join("|"),
      exintro: "1",
      explaintext: "1",
      redirects: "1",
      piprop: "thumbnail|original|name",
      pithumbsize: "900",
      pilicense: "any",
      format: "json",
      origin: "*",
    });
    const api = `https://${site}.wikipedia.org/w/api.php?${params.toString()}`;
    const data = await fetchJson<WikidataResponse>(api);
    for (const page of Object.values(data.query?.pages ?? {})) {
      const id = titleToId.get(page.title.toLocaleLowerCase());
      if (id) output.set(id, { summary: page.extract, imageUrl: page.thumbnail?.source });
    }
  }
  return output;
}

export function wikidataPageUrl(game: WikidataGame): string {
  if (game.wikipedia) return `https://${game.wikipedia.site}.wikipedia.org/wiki/${encodeURIComponent(game.wikipedia.title.replace(/ /g, "_"))}`;
  return `https://www.wikidata.org/wiki/${game.qid}`;
}
