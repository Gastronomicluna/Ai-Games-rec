import { NextRequest, NextResponse } from "next/server";
import { searchStore } from "@/lib/steam";
import { searchWikidata } from "@/lib/wikidata";

export const runtime = "nodejs";

interface SearchResult {
  id: string;
  name: string;
}

const cache = new Map<string, { results: SearchResult[]; ts: number }>();
const CACHE_TTL = 2 * 60 * 1000;

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json({ results: [] });
  const cacheKey = q.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return NextResponse.json({ results: cached.results });

  try {
    const [steamResults, wikidataResults] = await Promise.all([
      searchStore(q, 10),
      searchWikidata(q, 10).catch(() => []),
    ]);
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const result of steamResults) {
      const key = result.name.toLowerCase();
      if (!result.name || seen.has(key)) continue;
      seen.add(key);
      results.push({ id: `steam-${result.id}`, name: result.name });
    }
    for (const game of wikidataResults) {
      const key = game.name.toLowerCase();
      if (!game.name || seen.has(key)) continue;
      seen.add(key);
      results.push({ id: `wikidata-${game.id}`, name: game.name });
    }
    const final = results.slice(0, 10);
    cache.set(cacheKey, { results: final, ts: Date.now() });
    return NextResponse.json({ results: final });
  } catch {
    return NextResponse.json({ results: [], error: "搜索暂时不可用" }, { status: 500 });
  }
}
