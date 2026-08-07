export type WebSearchProvider = "tavily" | "brave";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number | null;
  publishedDate: string | null;
  domain: string;
}

export interface WebSearchOptions {
  maxResults?: number;
  includeDomains?: string[];
}

export interface WebSearchStats {
  requests: number;
  cacheHits: number;
  inFlightHits: number;
  failures: number;
}

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const CACHE_TTL = Math.max(0, Number(process.env.WEB_SEARCH_CACHE_TTL_MS ?? 0) || 0);
const MAX_CACHE_ENTRIES = 100;
const cache = new Map<string, { savedAt: number; results: WebSearchResult[] }>();
const inFlight = new Map<string, Promise<WebSearchResult[]>>();
const stats: WebSearchStats = { requests: 0, cacheHits: 0, inFlightHits: 0, failures: 0 };

function selectedProvider(): WebSearchProvider | null {
  const configured = process.env.WEB_SEARCH_PROVIDER?.trim().toLocaleLowerCase();
  if (configured === "tavily") return process.env.TAVILY_API_KEY?.trim() ? "tavily" : null;
  if (configured === "brave") return process.env.BRAVE_SEARCH_API_KEY?.trim() ? "brave" : null;
  if (process.env.TAVILY_API_KEY?.trim()) return "tavily";
  if (process.env.BRAVE_SEARCH_API_KEY?.trim()) return "brave";
  return null;
}

export function webSearchProvider(): WebSearchProvider | null {
  return selectedProvider();
}

export function isWebSearchConfigured(): boolean {
  return selectedProvider() !== null;
}

export function webSearchStats(): WebSearchStats {
  return { ...stats };
}

function normalizeDomains(values: string[] = []): string[] {
  return Array.from(new Set(values.map((value) => value.trim().toLocaleLowerCase().replace(/^www\./, "")).filter((value) => /^[a-z0-9.-]+$/.test(value)))).slice(0, 20);
}

function safeResult(title: unknown, urlValue: unknown, snippet: unknown, score: unknown, publishedDate: unknown): WebSearchResult | null {
  if (typeof title !== "string" || typeof urlValue !== "string") return null;
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return {
      title: title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240),
      url: url.toString(),
      snippet: typeof snippet === "string" ? snippet.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 900) : "",
      score: typeof score === "number" && Number.isFinite(score) ? score : null,
      publishedDate: typeof publishedDate === "string" && publishedDate.trim() ? publishedDate.trim().slice(0, 40) : null,
      domain: url.hostname.toLocaleLowerCase().replace(/^www\./, ""),
    };
  } catch {
    return null;
  }
}

async function tavilySearch(query: string, maxResults: number, includeDomains: string[], signal: AbortSignal): Promise<WebSearchResult[]> {
  const response = await fetch(TAVILY_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TAVILY_API_KEY!.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      ...(includeDomains.length > 0 ? { include_domains: includeDomains } : {}),
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Tavily Search API returned ${response.status}`);
  const data = await response.json() as { results?: { title?: unknown; url?: unknown; content?: unknown; score?: unknown; published_date?: unknown }[] };
  return (data.results ?? []).map((result) => safeResult(result.title, result.url, result.content, result.score, result.published_date)).filter((result): result is WebSearchResult => Boolean(result));
}

async function braveSearch(query: string, maxResults: number, includeDomains: string[], signal: AbortSignal): Promise<WebSearchResult[]> {
  const domainFilter = includeDomains.length > 0 ? ` (${includeDomains.map((domain) => `site:${domain}`).join(" OR ")})` : "";
  const params = new URLSearchParams({
    q: `${query}${domainFilter}`.slice(0, 400),
    count: String(Math.min(20, maxResults)),
    search_lang: "en",
    safesearch: "strict",
  });
  const response = await fetch(`${BRAVE_ENDPOINT}?${params.toString()}`, {
    headers: {
      "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY!.trim(),
      Accept: "application/json",
    },
    signal,
  });
  if (!response.ok) throw new Error(`Brave Search API returned ${response.status}`);
  const data = await response.json() as { web?: { results?: { title?: unknown; url?: unknown; description?: unknown; page_age?: unknown }[] } };
  return (data.web?.results ?? []).map((result) => safeResult(result.title, result.url, result.description, null, result.page_age)).filter((result): result is WebSearchResult => Boolean(result));
}

export async function searchWeb(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
  const provider = selectedProvider();
  const trimmed = query.trim().replace(/\s+/g, " ").slice(0, 320);
  if (!provider || !trimmed) return [];
  const maxResults = Math.max(1, Math.min(10, options.maxResults ?? 8));
  const includeDomains = normalizeDomains(options.includeDomains);
  const cacheKey = JSON.stringify({ provider, query: trimmed.toLocaleLowerCase(), maxResults, includeDomains });
  const cached = cache.get(cacheKey);
  if (CACHE_TTL > 0 && cached && Date.now() - cached.savedAt < CACHE_TTL) {
    stats.cacheHits += 1;
    return cached.results;
  }
  const active = inFlight.get(cacheKey);
  if (active) {
    stats.inFlightHits += 1;
    return active;
  }

  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      stats.requests += 1;
      const results = provider === "tavily"
        ? await tavilySearch(trimmed, maxResults, includeDomains, controller.signal)
        : await braveSearch(trimmed, maxResults, includeDomains, controller.signal);
      if (CACHE_TTL > 0 && results.length > 0) {
        cache.set(cacheKey, { savedAt: Date.now(), results });
        while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      }
      return results;
    } catch (error) {
      stats.failures += 1;
      console.warn(`[web-search] provider=${provider} failed:`, error instanceof Error ? error.message : error);
      return [];
    } finally {
      clearTimeout(timer);
    }
  })();
  inFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    inFlight.delete(cacheKey);
  }
}
