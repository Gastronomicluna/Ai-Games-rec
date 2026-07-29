import test from "node:test";
import assert from "node:assert/strict";

process.env.RAWG_API_KEY = "fixture-key";
const calls = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  calls.push(url);
  if (url.includes("/games/42/stores")) {
    return Response.json({ count: 1, results: [{ id: 1, game_id: 42, store_id: 1, url: "https://store.example/game" }] });
  }
  if (/\/games\/42\?/.test(url)) {
    return Response.json({
      id: 42,
      slug: "fixture-game",
      name: "Fixture Game",
      released: "2024-01-02",
      playtime: 12,
      platforms: [{ platform: { id: 1, name: "PC" } }, { platform: { id: 2, name: "PlayStation 5" } }],
      genres: [{ id: 1, name: "Adventure", slug: "adventure" }],
      tags: [
        { id: 2, name: "Singleplayer", slug: "singleplayer" },
        { id: 3, name: "Local Co-Op", slug: "local-co-op" },
      ],
      stores: [{ id: 1, store: { id: 1, name: "Steam", slug: "steam" } }],
      description_raw: "Fixture description",
      developers: [{ id: 4, name: "Fixture Studio" }],
      publishers: [],
    });
  }
  return Response.json({
    count: 1,
    results: [{
      id: 42,
      slug: "fixture-game",
      name: "Fixture Game",
      released: "2024-01-02",
      playtime: 12,
      platforms: [{ platform: { id: 1, name: "PC" } }],
      genres: [],
      tags: [],
      stores: [{ id: 1, store: { id: 1, name: "Steam", slug: "steam" } }],
    }],
  });
};

const rawg = await import("../lib/rawg.ts?test-fixture");

test("RAWG search adds the server-side key and returns verified results", async () => {
  const results = await rawg.searchRawg("Fixture Game", 1);
  assert.equal(results[0].id, 42);
  assert.match(calls[0], /key=fixture-key/);
  assert.match(calls[0], /search=Fixture\+Game/);
});

test("RAWG detail exposes playtime and multi-platform data", async () => {
  const detail = await rawg.getRawgGame(42);
  assert.equal(detail.playtime, 12);
  assert.deepEqual(rawg.rawgPlatformNames(detail), ["PC", "PlayStation 5"]);
  assert.equal(rawg.rawgHasSteam(detail), true);
});

test("RAWG tags infer player modes", async () => {
  const detail = await rawg.getRawgGame(42);
  assert.deepEqual(rawg.inferRawgPlayerModes(detail), ["单人", "合作", "本地/同屏合作"]);
});

test("RAWG store endpoint returns an external store link", async () => {
  const links = await rawg.getRawgStoreLinks(42);
  assert.equal(links[0].url, "https://store.example/game");
});
