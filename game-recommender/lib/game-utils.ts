import type { Game } from "./types";

export type SortMode = "match" | "rating" | "price" | "release";

function compareDescendingNullable(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function compareAscendingNullable(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function gameRatingScore(game: Game): number | null {
  return game.review?.positiveRate ?? game.metacritic;
}

function normalizedGameName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function gameIdentityKeys(game: Game): string[] {
  return [
    typeof game.steamAppId === "number" ? `steam:${game.steamAppId}` : "",
    normalizedGameName(game.name) ? `name:${normalizedGameName(game.name)}` : "",
    `${game.source}:${game.id}`,
  ].filter(Boolean);
}

export function mergeRecommendationGames(existing: Game[], incoming: Game[], limit = 120): Game[] {
  const merged: Game[] = [];
  const seen = new Set<string>();

  // The newest response comes first so its ranking and refreshed metadata win;
  // older candidates that were not returned again remain browsable afterward.
  for (const game of [...incoming, ...existing]) {
    const keys = gameIdentityKeys(game);
    if (keys.some((key) => seen.has(key))) continue;
    merged.push(game);
    for (const key of keys) seen.add(key);
    if (merged.length >= limit) break;
  }
  return merged;
}

export function updateRecommendationPool(
  existingCandidates: Game[],
  incoming: Game[],
  visibleLimit: number,
  poolLimit = 120
): { candidates: Game[]; visible: Game[] } {
  const candidates = mergeRecommendationGames(existingCandidates, incoming, poolLimit);
  return { candidates, visible: candidates.slice(0, Math.max(0, visibleLimit)) };
}

export function sortGames(games: Game[], mode: SortMode): Game[] {
  if (mode === "match") return games;
  const result = [...games];

  if (mode === "rating") {
    result.sort((a, b) => compareDescendingNullable(gameRatingScore(a), gameRatingScore(b)));
  } else if (mode === "price") {
    result.sort((a, b) => compareAscendingNullable(a.price.finalCny, b.price.finalCny));
  } else {
    result.sort((a, b) => compareDescendingNullable(a.releaseTimestamp, b.releaseTimestamp));
  }
  return result;
}
