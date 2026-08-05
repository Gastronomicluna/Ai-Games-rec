import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { unlink } from "node:fs/promises";

const cachePath = path.join(os.tmpdir(), `steam-cache-test-${Date.now()}-${Math.random()}.json`);
process.env.STEAM_CACHE_PATH = cachePath;
process.env.STEAM_CACHE_TTL_MS = "3600000";

let calls = 0;
globalThis.fetch = async (input) => {
  calls += 1;
  const url = new URL(String(input));
  if (url.pathname.endsWith("/storesearch/")) {
    return Response.json({ items: [{ type: "app", id: 1, name: "Fixture Game" }] });
  }
  if (url.pathname.endsWith("/appdetails")) {
    return Response.json({ "42": { success: true, data: { type: "game", name: "Fixture Detail" } } });
  }
  return new Response("not found", { status: 404 });
};

const steam = await import("../lib/steam.ts?steam-cache-fixture");

test("Steam search is persisted to disk and reused after module reload", async () => {
  const first = await steam.searchStore("Fixture Game", 5);
  assert.equal(first[0].name, "Fixture Game");
  assert.equal(calls, 1);

  const second = await steam.searchStore("Fixture Game", 5);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);

  await new Promise((resolve) => setTimeout(resolve, 30));
  const reloaded = await import("../lib/steam.ts?steam-cache-fixture-reloaded");
  const third = await reloaded.searchStore("Fixture Game", 5);
  assert.deepEqual(third, first);
  assert.equal(calls, 1);

  await unlink(cachePath).catch(() => undefined);
});

test("duplicate Steam detail requests share one in-flight request", async () => {
  const before = calls;
  const [first, second] = await Promise.all([steam.getAppData(42), steam.getAppData(42)]);
  assert.equal(first?.name, "Fixture Detail");
  assert.deepEqual(second, first);
  assert.equal(calls - before, 1);
});
