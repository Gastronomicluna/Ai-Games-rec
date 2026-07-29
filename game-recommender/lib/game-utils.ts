import type { Game } from "./types";

export type SortMode = "match" | "rating" | "price" | "release" | "playtime";

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

export function sortGames(games: Game[], mode: SortMode): Game[] {
  if (mode === "match") return games;
  const result = [...games];

  if (mode === "rating") {
    result.sort((a, b) => compareDescendingNullable(gameRatingScore(a), gameRatingScore(b)));
  } else if (mode === "price") {
    result.sort((a, b) => compareAscendingNullable(a.price.finalCny, b.price.finalCny));
  } else if (mode === "playtime") {
    result.sort((a, b) => compareAscendingNullable(a.playtimeHours, b.playtimeHours));
  } else {
    result.sort((a, b) => compareDescendingNullable(a.releaseTimestamp, b.releaseTimestamp));
  }
  return result;
}
