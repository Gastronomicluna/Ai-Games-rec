import type { ChatMessage, Platform, ReleaseFilter } from "./types";

const PLATFORM_LABELS: Record<Platform, string> = {
  steam: "Steam\uFF08PC\uFF09",
  psn: "PlayStation / PSN",
  ns: "Nintendo Switch",
};

export function transcript(messages: ChatMessage[]): string {
  return messages
    .map((message) => `${message.role === "user" ? "\u7528\u6237" : "\u52A9\u624B"}\uFF1A${message.content}`)
    .join("\n");
}

export function platformPreferenceText(platforms: Platform[]): string {
  return platforms.length > 0 ? platforms.map((platform) => PLATFORM_LABELS[platform]).join("\u3001") : "\u672A\u6307\u5B9A";
}

export function searchPlanKey(messages: ChatMessage[], platforms: Platform[] = []): string {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .join("\n");
  return `${[...platforms].sort().join(",")}\n${userText}`;
}

export function matchesPlatformFilter(
  platformNames: string[],
  platforms: Platform[],
  steamAvailable = false
): boolean {
  if (platforms.length === 0) return true;
  const names = platformNames.join(" ");
  return platforms.some((platform) => {
    if (platform === "steam") return steamAvailable;
    if (platform === "psn") return /playstation/i.test(names);
    return /nintendo switch|nintendo/i.test(names);
  });
}

export const RELEASE_FILTER_LABELS: Record<ReleaseFilter, string> = {
  all: "\u4E0D\u9650\u53D1\u552E\u65F6\u95F4",
  recent: "\u65B0\u6E38\u620F\uFF08\u8FD15\u5E74\uFF09",
  classic: "\u8001\u6E38\u620F\uFF082020\u5E74\u524D\uFF09",
  last1: "\u8FD11\u5E74",
  last3: "\u8FD13\u5E74",
  last5: "\u8FD15\u5E74",
  before2020: "2020\u5E74\u524D",
  before2010: "2010\u5E74\u524D",
};

export function releaseFilterText(filter: ReleaseFilter): string {
  return RELEASE_FILTER_LABELS[filter];
}

export function matchesReleaseFilter(value: number | string | null | undefined, filter: ReleaseFilter): boolean {
  if (filter === "all") return true;
  if (value === null || value === undefined) return false;
  const year = typeof value === "number" ? (value > 10_000 ? new Date(value).getFullYear() : value) : Number(value.slice(0, 4));
  if (!Number.isFinite(year)) return false;
  const currentYear = new Date().getFullYear();
  if (filter === "recent") return year >= currentYear - 4;
  if (filter === "classic") return year < 2020;
  if (filter === "last1") return year >= currentYear - 1;
  if (filter === "last3") return year >= currentYear - 2;
  if (filter === "last5") return year >= currentYear - 4;
  if (filter === "before2020") return year < 2020;
  if (filter === "before2010") return year < 2010;
  return true;
}
