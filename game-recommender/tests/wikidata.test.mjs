import test from "node:test";
import assert from "node:assert/strict";

const entity = (id, label, claims = {}, sitelinks = {}) => ({
  id,
  labels: { en: { value: label } },
  descriptions: { en: { value: "fixture video game" } },
  claims,
  sitelinks,
});
const entityClaim = (id) => ({ mainsnak: { datavalue: { value: { id } } } });
const stringClaim = (value) => ({ mainsnak: { datavalue: { value } } });
const timeClaim = (time) => ({ mainsnak: { datavalue: { value: { time } } } });

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const action = url.searchParams.get("action");
  if (action === "wbsearchentities") {
    const query = url.searchParams.get("search");
    return Response.json({
      search: [{ id: query === "Second Game" ? "Q43" : "Q42", label: query, description: "2024 video game" }],
    });
  }
  if (action === "wbgetentities") {
    const ids = url.searchParams.get("ids").split("|");
    const entities = {};
    for (const id of ids) {
      if (id === "Q42") {
        entities[id] = entity(id, "Fixture Game", {
          P400: [entityClaim("Q130")],
          P136: [entityClaim("Q1")],
          P404: [entityClaim("Q2")],
          P178: [entityClaim("Q3")],
          P123: [entityClaim("Q4")],
          P577: [timeClaim("+2024-01-02T00:00:00Z")],
          P18: [stringClaim("Fixture cover.jpg")],
          P856: [stringClaim("https://fixture.example")],
        }, { enwiki: { title: "Fixture Game" } });
      } else if (id === "Q43") {
        entities[id] = entity(id, "Second Game", { P400: [entityClaim("Q130")] });
      } else {
        const labels = { Q130: "Nintendo Switch", Q1: "Action game", Q2: "single-player video game", Q3: "Fixture Studio", Q4: "Fixture Publisher" };
        entities[id] = entity(id, labels[id] ?? id);
      }
    }
    return Response.json({ entities });
  }
  if (url.hostname.endsWith("wikipedia.org") && action === "query") {
    return Response.json({ query: { pages: { 1: { title: "Fixture Game", extract: "Long fixture summary", thumbnail: { source: "https://upload.wikimedia.org/fixture.jpg" } } } } });
  }
  return new Response("not found", { status: 404 });
};

const wikidata = await import("../lib/wikidata.ts?fixture");

test("Wikidata search resolves platform, genre, companies and release date", async () => {
  const games = await wikidata.searchWikidata("Fixture Game", 3);
  assert.equal(games[0].id, 42);
  assert.deepEqual(games[0].platforms, ["Nintendo Switch"]);
  assert.deepEqual(games[0].genres, ["Action game"]);
  assert.deepEqual(games[0].developers, ["Fixture Studio"]);
  assert.deepEqual(games[0].publishers, ["Fixture Publisher"]);
  assert.equal(games[0].releaseDate, "2024-01-02");
  assert.match(games[0].imageUrl, /Fixture%20cover.jpg/);
});

test("Wikidata batch search preserves query ordering", async () => {
  const results = await wikidata.searchWikidataBatch([
    { query: "Fixture Game", limit: 2 },
    { query: "Second Game", limit: 2 },
  ]);
  assert.equal(results[0][0].name, "Fixture Game");
  assert.equal(results[1][0].name, "Second Game");
});

test("Wikipedia enrichment adds summary and image", async () => {
  const game = (await wikidata.searchWikidata("Fixture Game", 3))[0];
  const enrichment = await wikidata.getWikipediaEnrichment([game]);
  assert.equal(enrichment.get(42).summary, "Long fixture summary");
  assert.equal(enrichment.get(42).imageUrl, "https://upload.wikimedia.org/fixture.jpg");
});
