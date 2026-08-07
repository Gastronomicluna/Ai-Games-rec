import test from "node:test";
import assert from "node:assert/strict";
import { mergeRecommendationGames, sortGames, updateRecommendationPool } from "../lib/game-utils.ts";

function game(id, { rating = null, metacritic = null, price = null, release = null } = {}) {
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
    storeUrl: "https://example.com",
    storeName: "商店",
  };
}

const fixtures = [
  game(1, { rating: 80, price: 100, release: 1000 }),
  game(2, { rating: 95, price: 0, release: 3000 }),
  game(3, { metacritic: 70, price: null, release: null }),
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

test("conversation recommendations keep old candidates and rank new ones first", () => {
  const existing = [game(1), game(2)];
  const incoming = [game(3), { ...game(2), reason: "updated reason" }];
  const merged = mergeRecommendationGames(existing, incoming);

  assert.deepEqual(merged.map((item) => item.id), [3, 2, 1]);
  assert.equal(merged[1].reason, "updated reason");
});

test("recommendation merging deduplicates the same title across providers", () => {
  const existing = [{ ...game(1), source: "gamebrain", name: "DOOM: The Dark Ages" }];
  const incoming = [{ ...game(99), source: "steam", name: "DOOM The Dark Ages", steamAppId: 3017860 }];
  const merged = mergeRecommendationGames(existing, incoming);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "steam");
});

test("candidate pool grows while the visible recommendation count stays fixed", () => {
  const existing = Array.from({ length: 10 }, (_, index) => game(index + 1));
  const incoming = Array.from({ length: 10 }, (_, index) => game(index + 11));
  const result = updateRecommendationPool(existing, incoming, 10);

  assert.equal(result.candidates.length, 20);
  assert.equal(result.visible.length, 10);
  assert.deepEqual(result.visible.map((item) => item.id), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
});

test("previous candidates can reappear without increasing the visible count", () => {
  const existing = Array.from({ length: 10 }, (_, index) => game(index + 1));
  const incoming = [{ ...game(3), reason: "newly reranked" }, game(11), game(12)];
  const result = updateRecommendationPool(existing, incoming, 5);

  assert.deepEqual(result.visible.map((item) => item.id), [3, 11, 12, 1, 2]);
  assert.equal(result.visible[0].reason, "newly reranked");
  assert.equal(result.candidates.length, 12);
});
