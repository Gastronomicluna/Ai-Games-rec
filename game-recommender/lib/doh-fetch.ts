// DNS-over-HTTPS resolution + node:https fetch for hosts blocked in China
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

const DOH_PROVIDERS = [
  "https://doh.pub/resolve",
  "https://dns.google/resolve",
  "https://cloudflare-dns.com/dns-query",
];

let dohCache = new Map<string, { ips: string[]; ts: number }>();
const DOH_CACHE_TTL = 10 * 60 * 1000;

async function resolveHostViaDoh(hostname: string): Promise<string[]> {
  const cached = dohCache.get(hostname);
  if (cached && Date.now() - cached.ts < DOH_CACHE_TTL) return cached.ips;

  for (const base of DOH_PROVIDERS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${base}?name=${encodeURIComponent(hostname)}&type=A`, {
        headers: { Accept: "application/dns-json" },
        signal: ctrl.signal,
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { Answer?: { type?: number; data?: string }[] };
      const ips = (data.Answer ?? [])
        .filter((a) => a.type === 1 && typeof a.data === "string")
        .map((a) => a.data!)
        .filter((ip) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip));
      if (ips.length > 0) {
        const unique = [...new Set(ips)];
        dohCache.set(hostname, { ips: unique, ts: Date.now() });
        return unique;
      }
    } catch {} finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`DNS-over-HTTPS: unable to resolve ${hostname}`);
}

export interface FetchResult {
  buffer: Buffer;
  contentType: string;
  statusCode: number;
}

function fetchWithIp(url: string, ip: string, timeoutMs: number): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: ip, family: 4 }]);
      else callback(null, ip, 4);
    };

    const req = httpsRequest(
      parsed,
      {
        headers: {
          "User-Agent": "WanShenMe/1.0",
          Accept: "image/*,*/*;q=0.8",
        },
        lookup,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 400) {
            resolve({
              buffer: Buffer.concat(chunks),
              contentType: res.headers["content-type"] ?? "image/jpeg",
              statusCode: status,
            });
          } else {
            reject(new Error(`Upstream HTTP ${status}`));
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function dohFetch(
  url: string,
  timeoutMs = 15000
): Promise<FetchResult> {
  const parsed = new URL(url);
  const ips = await resolveHostViaDoh(parsed.hostname);

  let lastErr: unknown;
  for (const ip of ips) {
    try {
      return await fetchWithIp(url, ip, timeoutMs);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`All DoH IPs failed for ${parsed.hostname}`);
}
