import { isIP } from "node:net";
import { isAllowedOfficialGameWebsite } from "./web-game-evidence.ts";

const CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const cache = new Map<string, { savedAt: number; imageUrl: string | null }>();
const inFlight = new Map<string, Promise<string | null>>();

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function privateHostname(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const parts = host.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
  }
  if (isIP(host) === 6) return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  return false;
}

function sameSite(page: URL, image: URL): boolean {
  const pageHost = page.hostname.toLocaleLowerCase().replace(/^www\./, "");
  const imageHost = image.hostname.toLocaleLowerCase().replace(/^www\./, "");
  return pageHost === imageHost || pageHost.endsWith(`.${imageHost}`) || imageHost.endsWith(`.${pageHost}`);
}

function absoluteImageUrl(value: string, pageUrl: string): string | null {
  try {
    const page = new URL(pageUrl);
    const image = new URL(decodeHtml(value.trim()), page);
    if (page.protocol !== "https:" || image.protocol !== "https:" || privateHostname(page.hostname) || privateHostname(image.hostname)) return null;
    return sameSite(page, image) ? image.toString() : null;
  } catch {
    return null;
  }
}

function imageValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(imageValues);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return imageValues(object.url ?? object.contentUrl);
}

function structuredImages(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(structuredImages);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const type = Array.isArray(object["@type"]) ? object["@type"].join(" ") : String(object["@type"] ?? "");
  const own = /product|video\s*game|softwareapplication/i.test(type) ? imageValues(object.image) : [];
  return [...own, ...Object.values(object).flatMap((child) => child === object.image ? [] : structuredImages(child))];
}

function metaAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attributes.set(match[1].toLocaleLowerCase(), match[3]);
  return attributes;
}

export function extractOfficialImageCandidates(html: string, pageUrl: string): string[] {
  const raw: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { raw.push(...structuredImages(JSON.parse(match[1]))); } catch {}
  }
  const meta = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = metaAttributes(match[0]);
    const key = (attributes.get("property") ?? attributes.get("name") ?? "").toLocaleLowerCase();
    const content = attributes.get("content");
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  raw.push(meta.get("og:image") ?? "", meta.get("og:image:secure_url") ?? "", meta.get("twitter:image") ?? "");
  const seen = new Set<string>();
  return raw.flatMap((value) => {
    if (!value) return [];
    const url = absoluteImageUrl(value, pageUrl);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [url];
  }).slice(0, 6);
}

async function readLimitedHtml(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_HTML_BYTES) throw new Error("Official page HTML is too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new Error("Official page HTML is too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

async function probeImage(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal, headers: { "User-Agent": "WanShenMe/1.0", Accept: "image/*" } });
    const type = response.headers.get("content-type") ?? "";
    const length = Number(response.headers.get("content-length"));
    return response.ok && /^image\//i.test(type) && (!Number.isFinite(length) || length <= MAX_IMAGE_BYTES);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function getOfficialPageImage(pageUrl: string): Promise<string | null> {
  if (!isAllowedOfficialGameWebsite(pageUrl)) return null;
  const cached = cache.get(pageUrl);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL) return cached.imageUrl;
  const active = inFlight.get(pageUrl);
  if (active) return active;
  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(pageUrl, { redirect: "follow", signal: controller.signal, headers: { "User-Agent": "WanShenMe/1.0", Accept: "text/html,application/xhtml+xml" } });
      if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? "")) return null;
      const html = await readLimitedHtml(response);
      const candidates = extractOfficialImageCandidates(html, response.url || pageUrl);
      for (const candidate of candidates.slice(0, 3)) if (await probeImage(candidate)) return candidate;
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  inFlight.set(pageUrl, request);
  try {
    const imageUrl = await request;
    cache.set(pageUrl, { savedAt: Date.now(), imageUrl });
    return imageUrl;
  } finally {
    inFlight.delete(pageUrl);
  }
}
