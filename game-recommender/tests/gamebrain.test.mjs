import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.GAMEBRAIN_API_KEY = "fixture-key";
process.env.GAMEBRAIN_MIN_REQUEST_INTERVAL_MS = "1";
process.env.GAMEBRAIN_CACHE_PATH = path.join(os.tmpdir(), `gamebrain-test-${Date.now()}-${Math.random()}.json`);

const calls = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  calls.push({ url, init });
  if (url.pathname.endsWith("/similar")) {
    return Response.json({ results: [{ id: 99, name: "Similar Fixture", image: "https://img.gamebrain.co/similar.jpg" }] }, { headers: { "x-api-quota-left": "47" } });
  }
  if (url.pathname.endsWith("/suggestions")) {
    return Response.json({ results: [{ id: 42, name: "Fixture Game", year: 2024, genre: "Action Roguelike" }] }, { headers: { "x-api-quota-left": "46" } });
  }
  const offset = Number(url.searchParams.get("offset"));
  const sparse = url.searchParams.get("query") === "Sparse Fixture";
  const pageSize = sparse ? 4 : 10;
  const results = Array.from({ length: pageSize }, (_, index) => ({
    id: offset + index + 1,
    name: `Fixture ${offset + index + 1}`,
    image: `https://img.gamebrain.co/games/fixture-${offset + index + 1}.jpg`,
    genre: "Action Roguelike",
    rating: { mean: 0.9, count: 100 },
    short_description: "Fixture description",
  }));
  return Response.json(
    { total_results: sparse ? 8 : 30, limit: pageSize, offset, results },
    { headers: { "x-api-quota-request": "1", "x-api-quota-used": String(calls.length), "x-api-quota-left": String(50 - calls.length) } }
  );
};

const gamebrain = await import("../lib/gamebrain.ts?fixture");

test("GameBrain paginates serially and applies platform filters", async () => {
  const games = await gamebrain.searchGameBrain("Hades easy roguelike", ["nintendo_switch"], 20);
  assert.equal(games.length, 20);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get("offset"), "0");
  assert.equal(calls[0].url.searchParams.get("limit"), "10");
  assert.equal(calls[1].url.searchParams.get("offset"), "10");
  assert.match(calls[0].url.searchParams.get("filters"), /nintendo_switch/);
  assert.equal(new Headers(calls[0].init.headers).get("x-api-key"), "fixture-key");
  assert.equal(gamebrain.gameBrainQuotaLeft(), 48);
});

test("GameBrain repeated search uses cache without spending quota", async () => {
  const games = await gamebrain.searchGameBrain("Hades easy roguelike", ["nintendo_switch"], 20);
  assert.equal(games.length, 20);
  assert.equal(calls.length, 2);
});


test("GameBrain Similar endpoint uses the shared quota client", async () => {
  const before = calls.length;
  const similar = await gamebrain.getSimilarGameBrain(42, 10);
  assert.equal(similar[0].id, 99);
  assert.equal(calls.length - before, 1);
});

test("GameBrain Suggestions resolves partial reference titles", async () => {
  const before = calls.length;
  const quotaBefore = gamebrain.gameBrainCacheStats().quotaTokens;
  const suggestions = await gamebrain.suggestGameBrain("Fixture", 5);
  assert.equal(suggestions[0].id, 42);
  assert.equal(suggestions[0].genre, "Action Roguelike");
  assert.equal(calls.length - before, 1);
  assert.ok(Math.abs(gamebrain.gameBrainCacheStats().quotaTokens - quotaBefore - 0.1) < 1e-9);
});


test("concurrent identical GameBrain suggestions share one request", async () => {
  const before = calls.length;
  const [first, second] = await Promise.all([
    gamebrain.suggestGameBrain("Parallel Fixture", 5),
    gamebrain.suggestGameBrain("Parallel Fixture", 5),
  ]);
  assert.equal(first[0].id, 42);
  assert.deepEqual(second, first);
  assert.equal(calls.length - before, 1);
});

test("GameBrain stops after page one once the requested recommendation count is covered", async () => {
  const before = calls.length;
  const games = await gamebrain.searchGameBrain("One Page Fixture", [], 20, 0, { minimumResults: 6, maxPages: 2 });
  assert.equal(games.length, 10);
  assert.equal(calls.length - before, 1);
});

test("GameBrain requests page two only when page one is short", async () => {
  const before = calls.length;
  const games = await gamebrain.searchGameBrain("Sparse Fixture", [], 20, 0, { minimumResults: 6, maxPages: 2 });
  assert.equal(games.length, 8);
  assert.equal(calls.length - before, 2);
});

test("multiple searches share one hard page-token budget", async () => {
  const before = calls.length;
  const budget = { remaining: 3, used: 0 };
  const first = await gamebrain.searchGameBrain("Budget Round One", [], 20, 0, { maxPages: 2, requestBudget: budget });
  const second = await gamebrain.searchGameBrain("Budget Round Two", [], 20, 0, { maxPages: 2, requestBudget: budget });
  const blocked = await gamebrain.searchGameBrain("Budget Round Three", [], 20, 0, { maxPages: 2, requestBudget: budget });
  assert.equal(first.length, 20);
  assert.equal(second.length, 10);
  assert.equal(blocked.length, 0);
  assert.deepEqual(budget, { remaining: 0, used: 3 });
  assert.equal(calls.length - before, 3);
});
