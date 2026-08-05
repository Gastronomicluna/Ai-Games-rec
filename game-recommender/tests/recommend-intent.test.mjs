import test from "node:test";
import assert from "node:assert/strict";

const intent = await import("../lib/recommend-intent.ts?fixture");

const user = (content) => [{ role: "user", content }];

test("intent parser distinguishes exact lookup from similar-game discovery", () => {
  const exact = intent.parseRecommendationIntent(user("\u641c\u7d22 Hades"), [], "all", new Date("2026-08-05T00:00:00Z"));
  assert.equal(exact.mode, "exact_lookup");
  assert.deepEqual(exact.referenceGames, ["Hades"]);

  const similar = intent.parseRecommendationIntent(user("\u63a8\u8350\u7c7b\u4f3c\u300aHades\u300b\u7684\u8089\u9e3d\u6e38\u620f"), [], "all", new Date("2026-08-05T00:00:00Z"));
  assert.equal(similar.mode, "similar_games");
  assert.deepEqual(similar.referenceGames, ["Hades"]);
});

test("intent parser turns natural-language release requirements into hard dates", () => {
  const recent = intent.parseRecommendationIntent(user("\u6211\u53ea\u60f3\u8981 2023\u5e74\u4ee5\u540e\u53d1\u552e\u7684\u6e38\u620f"), [], "all", new Date("2026-08-05T00:00:00Z"));
  assert.equal(recent.release.from, "2023-01-01");
  assert.equal(recent.release.includeUnknown, false);
  assert.equal(intent.matchesReleaseConstraint("2023-06-01", recent.release), true);
  assert.equal(intent.matchesReleaseConstraint("2022-12-31", recent.release), false);
  assert.equal(intent.matchesReleaseConstraint(undefined, recent.release), false);

  const range = intent.parseRecommendationIntent(user("\u60f3\u8981 2018 \u5230 2020 \u5e74\u7684\u6e38\u620f"), [], "all", new Date("2026-08-05T00:00:00Z"));
  assert.equal(range.release.from, "2018-01-01");
  assert.equal(range.release.to, "2021-01-01");
});

test("explicit UI release filter takes precedence over conflicting text", () => {
  const parsed = intent.parseRecommendationIntent(user("\u6211\u60f3\u8981 2010 \u5e74\u524d\u7684\u7ecf\u5178\u6e38\u620f"), [], "recent", new Date("2026-08-05T00:00:00Z"));
  assert.equal(parsed.release.source, "ui");
  assert.equal(parsed.release.from, "2022-01-01");
});



test("game title normalization preserves Chinese characters", () => {
  assert.equal(intent.normalizeGameTitle("\u9ed1\u795e\u8bdd\uff1a\u609f\u7a7a"), "\u9ed1\u795e\u8bdd\u609f\u7a7a");
  assert.equal(intent.normalizeGameTitle("Hades II"), "hadesii");
});


test("intent parser recognizes prefer-newest phrasing without forcing a fixed date", () => {
  const parsed = intent.parseRecommendationIntent(user("\u6211\u559c\u6b22\u300aSplatoon 3\u300b\uff0c\u8d8a\u65b0\u8d8a\u597d"));
  assert.equal(parsed.mode, "similar_games");
  assert.equal(parsed.recencyPreference, "prefer_newest");
  assert.equal(parsed.release.from, null);
});


test("intent parser extracts a NetEase company constraint", () => {
  const parsed = intent.parseRecommendationIntent(user("\u63a8\u8350\u7f51\u6613\u7684\u52a8\u4f5c\u6e38\u620f"));
  assert.deepEqual(parsed.companies, ["NetEase"]);
});


test("near-three-years uses the current year plus the two preceding calendar years", () => {
  const constraint = intent.releaseConstraintFromFilter("last3", new Date("2026-08-05T00:00:00Z"));
  assert.equal(constraint.from, "2024-01-01");
  assert.equal(intent.matchesReleaseConstraint("2026-01-01", constraint), true);
  assert.equal(intent.matchesReleaseConstraint("2024-01-01", constraint), true);
  assert.equal(intent.matchesReleaseConstraint("2023-12-31", constraint), false);
});

