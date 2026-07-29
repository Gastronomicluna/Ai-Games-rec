import { NextRequest, NextResponse } from "next/server";
import { searchStore } from "@/lib/steam";
import { searchRawg, isRawgConfigured } from "@/lib/rawg";

export const runtime = "nodejs";

interface SearchResult {
  steamId: number;
  name: string;
}

const cache = new Map<string, { results: SearchResult[]; ts: number }>();
const CACHE_TTL = 2 * 60 * 1000;

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const cacheKey = q.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({ results: cached.results });
  }

  try {
    // Always search both in parallel - Steam is fast, RAWG supplements
    const [steamResults, rawgResults] = await Promise.all([
      searchStore(q, 10),
      isRawgConfigured()
        ? Promise.race([
            searchRawg(q, 8),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 20000)),
          ]).catch(() => [])
        : Promise.resolve([] as Awaited<ReturnType<typeof searchRawg>>),
    ]);

    const seen = new Set<string>();
    const results: SearchResult[] = [];

    for (const r of steamResults) {
      if (r.name && r.id && !seen.has(r.name.toLowerCase())) {
        seen.add(r.name.toLowerCase());
        results.push({ steamId: r.id, name: r.name });
      }
    }

    for (const g of rawgResults) {
      if (g.name && !seen.has(g.name.toLowerCase())) {
        seen.add(g.name.toLowerCase());
        results.push({ steamId: g.id, name: g.name });
      }
    }

    const final = results.slice(0, 10);
    cache.set(cacheKey, { results: final, ts: Date.now() });
    return NextResponse.json({ results: final });
  } catch {
    return NextResponse.json({ results: [], error: "搜索暂时不可用" }, { status: 500 });
  }
}
