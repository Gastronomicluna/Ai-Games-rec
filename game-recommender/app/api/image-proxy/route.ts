import { NextRequest, NextResponse } from "next/server";
import { dohFetch } from "@/lib/doh-fetch";

export const runtime = "nodejs";
const CACHE_MAX_AGE = 86400 * 7;

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("Missing url parameter", { status: 400 });

  let parsed: URL;
  try { parsed = new URL(url); } catch { return new NextResponse("Invalid url", { status: 400 }); }

  // Try regular fetch first (works for Steam CDN)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "WanShenMe/1.0" } });
    clearTimeout(timer);
    if (res.ok) {
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      const buffer = await res.arrayBuffer();
      return new NextResponse(buffer, { status: 200, headers: { "Content-Type": contentType, "Cache-Control": `public, max-age=${CACHE_MAX_AGE}, immutable` } });
    }
  } catch {}

  // Fallback: DNS-over-HTTPS for blocked image CDN hosts (e.g. upload.wikimedia.org)
  try {
    const result = await dohFetch(url, 15000);
    return new NextResponse(new Uint8Array(result.buffer), { status: 200, headers: { "Content-Type": result.contentType, "Cache-Control": `public, max-age=${CACHE_MAX_AGE}, immutable` } });
  } catch {
    return new NextResponse("Proxy fetch failed", { status: 502 });
  }
}
