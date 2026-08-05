import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const suffix = Date.now() + "-" + Math.random();
process.env.GAMEBRAIN_API_KEY = "fixture-key";
process.env.GAMEBRAIN_MIN_REQUEST_INTERVAL_MS = "1";
process.env.GAMEBRAIN_CACHE_PATH = path.join(os.tmpdir(), "agent-flow-" + suffix + ".json");

let suggestCalls = 0;
let similarCalls = 0;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/suggestions")) {
    suggestCalls += 1;
    return Response.json({ results: [{ id: 100, name: "Hades", year: 2020, genre: "Action Roguelike" }] }, { headers: { "x-api-quota-left": "49" } });
  }
  if (url.pathname.endsWith("/similar")) {
    similarCalls += 1;
    return Response.json({ results: [{ id: 201, name: "Rogue Legacy 2", year: 2022, genre: "Action Roguelike" }] }, { headers: { "x-api-quota-left": "48" } });
  }
  return new Response("not found", { status: 404 });
};

const intent = await import("../lib/recommend-intent.ts?agent-flow");
const gamebrain = await import("../lib/gamebrain.ts?agent-flow");
const llmCache = await import("../lib/llm-cache.ts?agent-flow");

test("agent tool flow resolves a Chinese reference, expands Similar Games, and reuses cache", async () => {
  const parsed = intent.parseRecommendationIntent([{ role: "user", content: "\u63a8\u8350\u7c7b\u4f3c\u300aHades\u300b\u7684\u6e38\u620f" }]);
  assert.equal(parsed.mode, "similar_games");
  assert.deepEqual(parsed.referenceGames, ["Hades"]);

  const firstSuggestion = await gamebrain.suggestGameBrain(parsed.referenceGames[0], 5);
  const secondSuggestion = await gamebrain.suggestGameBrain(parsed.referenceGames[0], 5);
  assert.equal(firstSuggestion[0].id, 100);
  assert.deepEqual(secondSuggestion, firstSuggestion);
  assert.equal(suggestCalls, 1);

  const similar = await gamebrain.getSimilarGameBrain(firstSuggestion[0].id, 10);
  assert.equal(similar[0].name, "Rogue Legacy 2");
  assert.equal(similarCalls, 1);

  let decisionCalls = 0;
  const payload = { intent: parsed, candidates: similar.map((game) => "gamebrain:" + game.id) };
  await llmCache.getCachedLlmResult("agent-flow", payload, 1_000, async () => ({ action: "finalize" }));
  const second = await llmCache.getCachedLlmResult("agent-flow", payload, 1_000, async () => { decisionCalls += 1; return { action: "search" }; });
  assert.equal(second.value.action, "finalize");
  assert.equal(second.cacheHit, true);
  assert.equal(decisionCalls, 0);
});
