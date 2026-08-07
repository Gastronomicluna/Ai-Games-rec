import test from "node:test";
import assert from "node:assert/strict";

const { extractGameNamesFromWebLists, isAllowedOfficialGameWebsite } = await import("../lib/web-game-evidence.ts");
const { extractOfficialImageCandidates } = await import("../lib/official-page-metadata.ts");

test("web list evidence yields candidate titles without relying on one specific game", () => {
  const source = {
    title: "Games like Reference Game",
    url: "https://example.com/alternatives",
    domain: "example.com",
    snippet: "The best alternatives are: Alpha Quest | Beta Arena | Gamma Horror. 1. Delta Online · 2. Echo Mobile",
    score: 1,
    publishedDate: null,
  };
  const results = extractGameNamesFromWebLists([source], ["Reference Game"]);
  assert.deepEqual(results.map((game) => game.name), ["Delta Online", "Echo Mobile", "Alpha Quest", "Beta Arena", "Gamma Horror"]);
  assert.ok(results.every((game) => game.sourceUrls[0] === source.url));
});

test("mobile official-site validation rejects stores, video and social domains", () => {
  assert.equal(isAllowedOfficialGameWebsite("https://www.example-game.com/mobile"), true);
  assert.equal(isAllowedOfficialGameWebsite("https://games.publisher.example/title"), true);
  assert.equal(isAllowedOfficialGameWebsite("https://www.youtube.com/watch?v=trailer"), false);
  assert.equal(isAllowedOfficialGameWebsite("https://youtu.be/trailer"), false);
  assert.equal(isAllowedOfficialGameWebsite("https://play.google.com/store/apps/details?id=game"), false);
  assert.equal(isAllowedOfficialGameWebsite("https://apps.apple.com/app/game/id1"), false);
  assert.equal(isAllowedOfficialGameWebsite("https://discord.gg/game"), false);
  assert.equal(isAllowedOfficialGameWebsite("https://www.appbrain.com/app/example"), false);
  assert.equal(isAllowedOfficialGameWebsite("https://studio.itch.io/example"), false);
  assert.equal(isAllowedOfficialGameWebsite("https://www.gematsu.com/games/example"), false);
});

test("web list evidence rejects prose and page metadata masquerading as titles", () => {
  const source = {
    title: "Mobile alternatives",
    url: "https://example.com/list",
    snippet: "1. Identity V one-versus-four matches hunter versus four survivors decode machines | 2. Image 19 Game Art By Artist Image 20 Other Art | 3. Privacy Policy >> GooglePlay required environment | 4. Horrorfield",
  };
  assert.deepEqual(extractGameNamesFromWebLists([source], []).map((game) => game.name), ["Horrorfield"]);
});

test("official page metadata prefers structured product art over social images", () => {
  const html = `
    <meta content="/social.jpg" property="og:image">
    <meta name="twitter:image" content="/twitter.jpg">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Example","image":"/product.png"}</script>
  `;
  assert.deepEqual(extractOfficialImageCandidates(html, "https://games.example.com/title/index.html"), [
    "https://games.example.com/product.png",
    "https://games.example.com/social.jpg",
    "https://games.example.com/twitter.jpg",
  ]);
});

test("official page metadata rejects cross-site and non-HTTPS images", () => {
  const html = `<meta property="og:image" content="https://tracker.example.net/image.jpg"><meta name="twitter:image" content="http://games.example.com/image.jpg">`;
  assert.deepEqual(extractOfficialImageCandidates(html, "https://games.example.com/title"), []);
});
