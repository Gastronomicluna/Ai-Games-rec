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
