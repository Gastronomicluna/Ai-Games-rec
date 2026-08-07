import test from "node:test";
import assert from "node:assert/strict";

process.env.WEB_SEARCH_PROVIDER = "tavily";
process.env.TAVILY_API_KEY = "tvly-fixture";
process.env.BRAVE_SEARCH_API_KEY = "brave-fixture";
process.env.WEB_SEARCH_CACHE_TTL_MS = "0";

const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  calls.push({ url, init });
  await new Promise((resolve) => setTimeout(resolve, 2));
  if (url.hostname === "api.tavily.com") {
    return Response.json({
      results: [
        { title: "Ten games like Hades", url: "https://example.com/games-like-hades", content: "Dead Cells and Curse of the Dead Gods share action roguelike combat.", score: 0.91 },
        { title: "Unsafe", url: "http://unsafe.example/game", content: "discard me", score: 0.5 },
      ],
    });
  }
  return Response.json({ web: { results: [{ title: "Official list", url: "https://www.ign.com/articles/games-like-hades", description: "More action roguelikes." }] } });
};

const webSearch = await import("../lib/web-search.ts?fixture");

test("Tavily provider returns sanitized HTTPS evidence and shares in-flight calls", async () => {
  const before = calls.length;
  const [first, second] = await Promise.all([
    webSearch.searchWeb("games like Hades", { maxResults: 8 }),
    webSearch.searchWeb("games like Hades", { maxResults: 8 }),
  ]);
  assert.equal(calls.length - before, 1);
  assert.deepEqual(second, first);
  assert.equal(first.length, 1);
  assert.equal(first[0].domain, "example.com");
  assert.equal(new Headers(calls[before].init.headers).get("authorization"), "Bearer tvly-fixture");
  const body = JSON.parse(calls[before].init.body);
  assert.equal(body.search_depth, "basic");
  assert.equal(body.include_raw_content, false);
});

test("Brave provider uses its subscription header and site filters", async () => {
  process.env.WEB_SEARCH_PROVIDER = "brave";
  const before = calls.length;
  const results = await webSearch.searchWeb("games like Hades", { includeDomains: ["ign.com"], maxResults: 5 });
  assert.equal(calls.length - before, 1);
  assert.match(calls[before].url.searchParams.get("q"), /site:ign\.com/);
  assert.equal(new Headers(calls[before].init.headers).get("x-subscription-token"), "brave-fixture");
  assert.equal(results[0].domain, "ign.com");
});
