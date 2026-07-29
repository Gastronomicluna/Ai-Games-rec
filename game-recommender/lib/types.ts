export type Platform = "steam" | "psn" | "ns";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GamePrice {
  formatted: string;
  finalCny: number | null;
  discountPercent: number;
}

export interface GameReview {
  label: string;
  positiveRate: number;
  total: number;
  source: "steam" | "rawg";
}

export interface Game {
  id: number;
  source: "rawg" | "steam";
  steamAppId: number | null;
  name: string;
  headerImage: string;
  shortDescription: string;
  reason: string;
  genres: string[];
  tags: string[];
  playerModes: string[];
  platformNames: string[];
  price: GamePrice;
  releaseDate: string;
  releaseTimestamp: number | null;
  developers: string[];
  publishers: string[];
  platforms: { windows: boolean; mac: boolean; linux: boolean };
  metacritic: number | null;
  review: GameReview | null;
  playtimeHours: number | null;
  storeUrl: string;
  storeName: string;
}

export interface RecommendResponse {
  reply: string;
  games: Game[];
}
