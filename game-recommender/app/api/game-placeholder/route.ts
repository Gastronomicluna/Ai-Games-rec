import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

function hash(value: string): number {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name")?.trim().slice(0, 60) || "GAME";
  const seed = hash(name);
  const hues = [18, 32, 192, 205, 252, 278, 332];
  const hueA = hues[seed % hues.length];
  const hueB = hues[(seed >>> 5) % hues.length];
  const safeName = escapeXml(name.length > 28 ? `${name.slice(0, 27)}…` : name);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hueA} 72% 42%)"/><stop offset="1" stop-color="hsl(${hueB} 66% 24%)"/></linearGradient></defs>
    <rect width="640" height="360" fill="url(#g)"/>
    <g opacity=".16" fill="#fff">${Array.from({ length: 36 }, (_, i) => `<rect x="${(i * 83 + seed) % 640}" y="${(i * 47 + (seed >>> 8)) % 360}" width="12" height="12"/>`).join("")}</g>
    <g transform="translate(270 92)" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="square" stroke-linejoin="round"><path d="M15 48h70l24 66c7 19-17 33-29 17l-18-23H38l-18 23c-12 16-36 2-29-17z"/><path d="M31 69v28M17 83h28M75 80h1M91 96h1"/></g>
    <text x="320" y="286" text-anchor="middle" fill="#fff" font-family="Arial, sans-serif" font-size="30" font-weight="700">${safeName}</text>
    <text x="320" y="320" text-anchor="middle" fill="#fff" opacity=".72" font-family="Arial, sans-serif" font-size="14" letter-spacing="4">GAME COVER</text>
  </svg>`;
  return new NextResponse(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } });
}
