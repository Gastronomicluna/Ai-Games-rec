import test from "node:test";
import assert from "node:assert/strict";

const preferences = await import("../lib/recommend-preferences.ts");

test("transcript includes the actual user preference text", () => {
  const result = preferences.transcript([
    { role: "user", content: "我喜欢《哈迪斯》，想找类似的动作肉鸽" },
    { role: "assistant", content: "明白" },
  ]);

  assert.match(result, /用户：我喜欢《哈迪斯》/);
  assert.match(result, /助手：明白/);
  assert.doesNotMatch(result, /\{message\.content\}/);
});

test("search plan cache key separates different platform preferences", () => {
  const messages = [{ role: "user", content: "推荐类似游戏" }];
  assert.notEqual(
    preferences.searchPlanKey(messages, ["steam"]),
    preferences.searchPlanKey(messages, ["ns"])
  );
  assert.equal(
    preferences.searchPlanKey(messages, ["ns", "steam"]),
    preferences.searchPlanKey(messages, ["steam", "ns"])
  );
});

test("Steam filtering requires a verified Steam match", () => {
  assert.equal(preferences.matchesPlatformFilter(["PC (Microsoft Windows)"], ["steam"], false), false);
  assert.equal(preferences.matchesPlatformFilter(["PC (Microsoft Windows)"], ["steam"], true), true);
});

test("console filtering respects PlayStation and Nintendo Switch names", () => {
  const platforms = ["PlayStation 5", "Nintendo Switch"];
  assert.equal(preferences.matchesPlatformFilter(platforms, ["psn"]), true);
  assert.equal(preferences.matchesPlatformFilter(platforms, ["ns"]), true);
  assert.equal(preferences.matchesPlatformFilter(platforms, ["steam"], false), false);
});

test("mobile filtering recognizes Android and iOS without requiring Steam", () => {
  assert.equal(preferences.matchesPlatformFilter(["Android"], ["mobile"]), true);
  assert.equal(preferences.matchesPlatformFilter(["iOS"], ["mobile"]), true);
  assert.equal(preferences.matchesPlatformFilter(["Windows / Steam"], ["mobile"], true), false);
});

test("company matching is normalized without assuming undocumented ownership", () => {
  assert.equal(preferences.matchesCompanyNames(["NetEase Games"], ["NetEase"]), true);
  assert.equal(preferences.matchesCompanyNames(["NETEASE-GAMES"], ["NetEase Games"]), true);
  assert.equal(preferences.matchesCompanyNames(["Independent Studio"], ["Publisher Group"]), false);
  assert.equal(preferences.matchesCompanyNames(["Capcom"], ["NetEase"]), false);
  assert.equal(preferences.matchesCompanyNames(["Tencent Games publishes this title"], ["Tencent"]), true);
});


test("release filters match relative and fixed year ranges", () => {
  assert.equal(preferences.matchesReleaseFilter("2024-01-01", "before2020"), false);
  assert.equal(preferences.matchesReleaseFilter("2019-12-31", "before2020"), true);
  assert.equal(preferences.matchesReleaseFilter("2010-01-01", "before2010"), false);
  assert.equal(preferences.matchesReleaseFilter("2009-12-31", "before2010"), true);
  assert.equal(preferences.matchesReleaseFilter("2024-01-01", "all"), true);
  assert.equal(preferences.matchesReleaseFilter("2024-01-01", "recent"), true);
  assert.equal(preferences.matchesReleaseFilter("2019-12-31", "classic"), true);
  assert.equal(preferences.matchesReleaseFilter("2024-01-01", "classic"), false);
  assert.equal(preferences.matchesReleaseFilter(undefined, "recent"), false);
});


test("calendar-year near-three filter includes the current year", () => {
  const currentYear = new Date().getFullYear();
  assert.equal(preferences.matchesReleaseFilter(String(currentYear), "last3"), true);
  assert.equal(preferences.matchesReleaseFilter(String(currentYear - 2), "last3"), true);
  assert.equal(preferences.matchesReleaseFilter(String(currentYear - 3), "last3"), false);
});


test("near-one-year includes current and previous calendar year", () => {
  const currentYear = new Date().getFullYear();
  assert.equal(preferences.matchesReleaseFilter(String(currentYear), "last1"), true);
  assert.equal(preferences.matchesReleaseFilter(String(currentYear - 1), "last1"), true);
  assert.equal(preferences.matchesReleaseFilter(String(currentYear - 2), "last1"), false);
});

test("legacy release options migrate to the visible non-duplicate presets", () => {
  assert.equal(preferences.normalizeReleaseFilter("recent"), "last5");
  assert.equal(preferences.normalizeReleaseFilter("classic"), "before2020");
  assert.equal(preferences.normalizeReleaseFilter("last3"), "last3");
  assert.equal(preferences.normalizeReleaseFilter("unexpected"), "all");
});

test("deterministic fallback converts Chinese combat intent into distinct English queries", () => {
  const messages = [{ role: "user", content: "我想玩动作类型的3A作品，要注重战斗" }];
  const first = preferences.deterministicSearchQuery(messages, "last1", 0);
  const second = preferences.deterministicSearchQuery(messages, "last1", 1);
  const third = preferences.deterministicSearchQuery(messages, "last1", 2);

  assert.equal(first, "AAA games");
  assert.match(second, /\bcombat\b/);
  assert.match(second, /\baction\b/);
  assert.match(third, /\bAAA\b/);
  assert.match(third, /\bshooter\b/);
  assert.doesNotMatch(first + second + third, /[\u3400-\u9fff]/);
  assert.notEqual(first, second);
  assert.notEqual(second, third);
});

test("agent queries cannot drop explicit action and combat requirements", () => {
  const currentYear = new Date().getFullYear();
  const messages = [{ role: "user", content: "我想玩动作类型的3A作品，要注重战斗" }];
  const query = preferences.enforceSearchQueryIntent(`AAA games ${currentYear - 1}`, messages, "last1");

  assert.match(query, /\bAAA\b/);
  assert.match(query, /\baction\b/);
  assert.match(query, /\bcombat\b/);
  assert.match(query, new RegExp(`\\b${currentYear - 1}\\b`));
  assert.match(query, new RegExp(`\\b${currentYear}\\b`));
});

test("GameBrain search keeps one seed title instead of mixing many candidates", () => {
  const currentYear = new Date().getFullYear();
  const messages = [{ role: "user", content: "\u6211\u60f3\u73a9\u52a8\u4f5c\u7c7b\u578b\u76843A\u4f5c\u54c1\uff0c\u8981\u6ce8\u91cd\u6218\u6597" }];
  const query = preferences.compactGameBrainSearchQuery(
    "Elden Ring Nightreign The First Berserker Khazan Stellar Blade 2025 AAA action combat Steam 2026",
    ["Elden Ring Nightreign", "The First Berserker Khazan", "Stellar Blade"],
    [],
    messages,
    "last1"
  );

  assert.match(query, /Elden Ring Nightreign/i);
  assert.doesNotMatch(query, /The First Berserker Khazan/i);
  assert.doesNotMatch(query, /Stellar Blade/i);
  assert.doesNotMatch(query, /Steam/i);
  assert.match(query, /\baction\b/i);
  assert.match(query, /\bcombat\b/i);
  assert.match(query, new RegExp(`\\b${currentYear}\\b`));
});

test("GameBrain facets infer documented genre and theme keys", () => {
  const messages = [{ role: "user", content: "\u60f3\u73a9\u9ed1\u6697\u5947\u5e7b\u52a8\u4f5c RPG\uff0c\u6ce8\u91cd\u6218\u6597" }];
  assert.deepEqual(preferences.inferGameBrainGenres(messages, "action role playing games"), ["action", "role_playing"]);
  assert.deepEqual(preferences.inferGameBrainThemes(messages, "dark fantasy games"), ["dark_fantasy"]);
});
