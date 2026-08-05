import test from "node:test";
import assert from "node:assert/strict";

const llmCache = await import("../lib/llm-cache.ts?fixture");

test("LLM cache reuses completed and in-flight results", async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { action: "search" };
  };
  const [first, second] = await Promise.all([
    llmCache.getCachedLlmResult("agent", { query: "Hades" }, 1_000, loader),
    llmCache.getCachedLlmResult("agent", { query: "Hades" }, 1_000, loader),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.value.action, "search");
  assert.equal(second.value.action, "search");

  const third = await llmCache.getCachedLlmResult("agent", { query: "Hades" }, 1_000, loader);
  assert.equal(calls, 1);
  assert.equal(third.cacheHit, true);
});
