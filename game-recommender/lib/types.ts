export type Platform = "steam" | "psn" | "ns";
export type ReleaseFilter = "all" | "recent" | "classic" | "last1" | "last3" | "last5" | "before2020" | "before2010";

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
  source: "steam" | "gamebrain" | "wikidata" | "rawg";
}

export interface Game {
  id: number;
  source: "gamebrain" | "wikidata" | "steam" | "rawg";
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


export interface PreviousRecommendation {
  id: number;
  name: string;
  platformNames: string[];
  genres: string[];
  tags: string[];
  playerModes: string[];
  reason: string;
}

export interface AgentTraceEvent {
  id: string;
  stage: "intent" | "profile" | "agent" | "tool" | "filter" | "rank" | "enrich" | "complete" | "error";
  title: string;
  detail: string;
  timestamp: number;
}

export interface RecommendResponse {
  reply: string;
  games: Game[];
}
