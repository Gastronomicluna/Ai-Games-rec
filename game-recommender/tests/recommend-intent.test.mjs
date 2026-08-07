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

test("intent parser recognizes Tencent production phrasing", () => {
  const parsed = intent.parseRecommendationIntent(user("\u5e2e\u6211\u63a8\u8350\u817e\u8baf\u51fa\u54c1\u7684\u6e38\u620f"));
  assert.deepEqual(parsed.companies, ["Tencent"]);
});

test("intent parser generically extracts an unknown company before production cues", () => {
  const parsed = intent.parseRecommendationIntent(user("\u5e2e\u6211\u63a8\u8350Supercell\u51fa\u54c1\u7684\u624b\u6e38"));
  assert.deepEqual(parsed.companies, ["Supercell"]);
});

test("intent parser extracts platform, co-op, player count, and free price constraints", () => {
  const parsed = intent.parseRecommendationIntent(user("我想找适合两个人合作、只要免费、Steam 上能玩的游戏"));
  assert.deepEqual(parsed.platforms, ["steam"]);
  assert.deepEqual(parsed.playModes, ["co_op", "two_players"]);
  assert.equal(parsed.price.freeOnly, true);
  assert.equal(parsed.price.maxUsd, 0);
});

test("intent parser recognizes mobile as a first-class platform", () => {
  const parsed = intent.parseRecommendationIntent([{ role: "user", content: "\u60f3\u627e Android \u548c iOS \u90fd\u80fd\u73a9\u7684\u624b\u6e38" }]);
  assert.deepEqual(parsed.platforms, ["mobile"]);
});

test("trait-based phrasing extracts a reference game without title-specific rules", () => {
  const cases = [
    "\u6211\u60f3\u627e\u753b\u98ce\u548c\u73a9\u6cd5\u7c7b\u4f3c\u7b2c\u4e94\u4eba\u683c\u7684\u624b\u6e38",
    "\u63a8\u8350\u7c7b\u4f3c\u7b2c\u4e94\u4eba\u683c\u753b\u98ce\u7684\u6e38\u620f",
    "\u6211\u60f3\u627e\u7b2c\u4e94\u4eba\u683c\u73a9\u6cd5\u7684\u6e38\u620f",
  ];
  for (const content of cases) {
    const parsed = intent.parseRecommendationIntent([{ role: "user", content }]);
    assert.deepEqual(parsed.referenceGames, ["\u7b2c\u4e94\u4eba\u683c"]);
    assert.equal(parsed.mode, "similar_games");
  }
});


test("near-three-years uses the current year plus the two preceding calendar years", () => {
  const constraint = intent.releaseConstraintFromFilter("last3", new Date("2026-08-05T00:00:00Z"));
  assert.equal(constraint.from, "2024-01-01");
  assert.equal(intent.matchesReleaseConstraint("2026-01-01", constraint), true);
  assert.equal(intent.matchesReleaseConstraint("2024-01-01", constraint), true);
  assert.equal(intent.matchesReleaseConstraint("2023-12-31", constraint), false);
});



test("near-one-year includes the current and previous calendar year", () => {
  const constraint = intent.releaseConstraintFromFilter("last1", new Date("2026-08-05T00:00:00Z"));
  assert.equal(constraint.from, "2025-01-01");
  assert.equal(intent.matchesReleaseConstraint("2026-01-01", constraint), true);
  assert.equal(intent.matchesReleaseConstraint("2025-01-01", constraint), true);
  assert.equal(intent.matchesReleaseConstraint("2024-12-31", constraint), false);
});

test("near-five-years includes 2026 and starts at 2022", () => {
  const constraint = intent.releaseConstraintFromFilter("last5", new Date("2026-08-05T00:00:00Z"));
  assert.equal(constraint.from, "2022-01-01");
  assert.equal(intent.matchesReleaseConstraint("2026-12-31", constraint), true);
  assert.equal(intent.matchesReleaseConstraint("2022-01-01", constraint), true);
  assert.equal(intent.matchesReleaseConstraint("2021-12-31", constraint), false);
});

test("natural-language near-year ranges match the UI presets", () => {
  const now = new Date("2026-08-05T00:00:00Z");
  assert.equal(intent.parseRecommendationIntent(user("推荐近1年的游戏"), [], "all", now).release.from, "2025-01-01");
  assert.equal(intent.parseRecommendationIntent(user("推荐近3年的游戏"), [], "all", now).release.from, "2024-01-01");
  assert.equal(intent.parseRecommendationIntent(user("推荐近5年的游戏"), [], "all", now).release.from, "2022-01-01");
});
