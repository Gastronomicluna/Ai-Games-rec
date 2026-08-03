import type { ChatMessage, Platform, ReleaseFilter } from "./types";

const PLATFORM_LABELS: Record<Platform, string> = {
  steam: "Steam（PC）",
  psn: "PlayStation / PSN",
  ns: "Nintendo Switch",
};

const CONSOLE_PLATFORM_MAP: Record<Exclude<Platform, "steam">, RegExp> = {
  psn: /playstation/i,
  ns: /nintendo/i,
};

export function transcript(messages: ChatMessage[]): string {
  return messages
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`)
    .join("\n");
}

export function platformPreferenceText(platforms: Platform[]): string {
  return platforms.length > 0 ? platforms.map((platform) => PLATFORM_LABELS[platform]).join("、") : "未指定";
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
  all: "不限发售时间",
  last1: "近1年",
  last3: "近3年",
  last5: "近5年",
  before2020: "2020年前",
  before2010: "2010年前",
};

export function releaseFilterText(filter: ReleaseFilter): string {
  return RELEASE_FILTER_LABELS[filter];
}

export function matchesReleaseFilter(value: number | string | null | undefined, filter: ReleaseFilter): boolean {
  if (filter === "all" || value === null || value === undefined) return true;
  const year = typeof value === "number" ? (value > 10_000 ? new Date(value).getFullYear() : value) : Number(value.slice(0, 4));
  if (!Number.isFinite(year)) return true;
  const currentYear = new Date().getFullYear();
  if (filter === "last1") return year >= currentYear - 1;
  if (filter === "last3") return year >= currentYear - 3;
  if (filter === "last5") return year >= currentYear - 5;
  if (filter === "before2020") return year < 2020;
  if (filter === "before2010") return year < 2010;
  return true;
}
