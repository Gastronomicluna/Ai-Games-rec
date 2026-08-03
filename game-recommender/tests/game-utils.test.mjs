import test from "node:test";
import assert from "node:assert/strict";
import { sortGames } from "../lib/game-utils.ts";

function game(id, { rating = null, metacritic = null, price = null, release = null, playtime = null } = {}) {
  return {
    id,
    source: "wikidata",
    steamAppId: null,
    name: `Game ${id}`,
    headerImage: "",
    shortDescription: "",
    reason: "fixture",
    genres: [],
    tags: [],
    playerModes: [],
    platformNames: ["PC"],
    price: { formatted: price === null ? "暂无价格" : String(price), finalCny: price, discountPercent: 0 },
    releaseDate: "未知",
    releaseTimestamp: release,
    developers: [],
    publishers: [],
    platforms: { windows: true, mac: false, linux: false },
    metacritic,
    review: rating === null ? null : { label: "fixture", positiveRate: rating, total: 10, source: "wikidata" },
    playtimeHours: playtime,
    storeUrl: "https://example.com",
    storeName: "商店",
  };
}

const fixtures = [
  game(1, { rating: 80, price: 100, release: 1000, playtime: 20 }),
  game(2, { rating: 95, price: 0, release: 3000, playtime: 8 }),
  game(3, { metacritic: 70, price: null, release: null, playtime: null }),
];

test("match sorting preserves AI order and reference", () => {
  assert.equal(sortGames(fixtures, "match"), fixtures);
});

test("rating sorting is descending", () => {
  assert.deepEqual(sortGames(fixtures, "rating").map((item) => item.id), [2, 1, 3]);
});

test("price sorting is ascending with missing prices last", () => {
  assert.deepEqual(sortGames(fixtures, "price").map((item) => item.id), [2, 1, 3]);
});

test("release sorting is newest first with unknown dates last", () => {
  assert.deepEqual(sortGames(fixtures, "release").map((item) => item.id), [2, 1, 3]);
});

test("playtime sorting is shortest first with unknown durations last", () => {
  assert.deepEqual(sortGames(fixtures, "playtime").map((item) => item.id), [2, 1, 3]);
});
