import type { ChatMessage, Platform, ReleaseFilter } from "./types";

const PLATFORM_LABELS: Record<Platform, string> = {
  steam: "Steam\uFF08PC\uFF09",
  psn: "PlayStation / PSN",
  ns: "Nintendo Switch",
  mobile: "\u624B\u6E38\uFF08Android / iOS\uFF09",
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
    if (platform === "ns") return /nintendo switch|nintendo/i.test(names);
    return /android|ios|iphone|ipad|mobile|\u624B\u6E38|\u79FB\u52A8/i.test(names);
  });
}

function normalizeCompanyName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function matchesCompanyNames(knownCompanies: string[], requestedCompanies: string[]): boolean {
  if (requestedCompanies.length === 0) return true;
  const known = knownCompanies.map(normalizeCompanyName).filter(Boolean);
  if (known.length === 0) return false;

  return requestedCompanies.every((requested) => {
    const target = normalizeCompanyName(requested);
    if (!target) return true;
    return known.some((name) => name === target || name.includes(target) || target.includes(name));
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

export function deterministicSearchQuery(messages: ChatMessage[], releaseFilter: ReleaseFilter, variant = 0): string {
  const text = messages.filter((message) => message.role === "user").map((message) => message.content).join(" ");
  const terms: string[] = [];
  const add = (...values: string[]) => {
    for (const value of values) {
      if (!terms.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) terms.push(value);
    }
  };

  const wantsAAA = /(?:\bAAA\b|3A)/i.test(text);
  const wantsAction = /(?:动作|\baction\b)/i.test(text);
  const wantsCombat = /(?:战斗|combat)/i.test(text);
  const focusedAAACombat = wantsAAA && wantsAction && wantsCombat;
  if (focusedAAACombat) {
    if (variant === 0) add("AAA");
    else if (variant === 1) add("action", "combat");
    else add("AAA", "shooter");
  } else {
    if (wantsAAA) add("AAA");
    if (wantsAction) add("action");
    if (wantsCombat) add("combat");
  }
  if (/(?:射击|shooter|shooting)/i.test(text)) add("shooter");
  if (/(?:角色扮演|\bRPG\b|role.?playing)/i.test(text)) add("RPG");
  if (/(?:开放世界|open.?world)/i.test(text)) add("open world");
  if (/(?:类魂|魂系|souls.?like)/i.test(text)) add("soulslike");
  if (/(?:砍杀|hack.?and.?slash)/i.test(text)) add("hack and slash");
  if (/(?:格斗|fighting)/i.test(text)) add("fighting");
  if (/(?:恐怖|horror)/i.test(text)) add("horror");
  if (/(?:策略|strategy)/i.test(text)) add("strategy");
  if (/(?:合作|co-?op|cooperative)/i.test(text)) add("co-op");
  if (/(?:多人|multiplayer)/i.test(text)) add("multiplayer");
  if (/(?:单人|single.?player)/i.test(text)) add("single player");

  if (terms.length === 0) add("video");
  if (!focusedAAACombat && variant === 1) add("action adventure", "hack and slash", "third person");
  if (!focusedAAACombat && variant >= 2) add("melee", "shooter", "soulslike", "combat");
  add("games");

  return terms.join(" ");
}

export function enforceSearchQueryIntent(query: string, messages: ChatMessage[], releaseFilter: ReleaseFilter): string {
  if (/[\u3400-\u9fff]/.test(query)) return deterministicSearchQuery(messages, releaseFilter);
  const userText = messages.filter((message) => message.role === "user").map((message) => message.content).join(" ");
  let output = query.trim().replace(/\s+/g, " ");
  const append = (requested: boolean, term: string, present: RegExp) => {
    if (requested && !present.test(output)) output += ` ${term}`;
  };
  append(/(?:\bAAA\b|3A)/i.test(userText), "AAA", /(?:\bAAA\b|3A)/i);
  append(/(?:动作|\baction\b)/i.test(userText), "action", /\baction\b/i);
  append(/(?:战斗|combat)/i.test(userText), "combat", /\bcombat\b/i);
  append(/(?:射击|shooter|shooting)/i.test(userText), "shooter", /\b(?:shooter|shooting)\b/i);
  append(/(?:角色扮演|\bRPG\b|role.?playing)/i.test(userText), "RPG", /\b(?:RPG|role.?playing)\b/i);
  append(/(?:开放世界|open.?world)/i.test(userText), "open world", /\bopen.?world\b/i);
  append(/(?:类魂|魂系|souls.?like)/i.test(userText), "soulslike", /\bsouls.?like\b/i);
  append(/(?:合作|co-?op|cooperative)/i.test(userText), "co-op", /\b(?:co-?op|cooperative)\b/i);

  const currentYear = new Date().getFullYear();
  if (releaseFilter === "last1") {
    append(true, String(currentYear - 1), new RegExp(`\\b${currentYear - 1}\\b`));
    append(true, String(currentYear), new RegExp(`\\b${currentYear}\\b`));
  }
  return output.trim().slice(0, 180);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compactGameBrainSearchQuery(
  query: string,
  titles: string[],
  references: string[],
  messages: ChatMessage[],
  releaseFilter: ReleaseFilter
): string {
  let output = query.replace(/Nintendo Switch|PlayStation|Steam|Windows|\bPC\b/gi, " ").replace(/\s+/g, " ").trim();
  const protectedTitles = new Set(references.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean));
  const embeddedTitles = titles
    .map((value) => value.trim())
    .filter((value) => value.length >= 4 && new RegExp(escapeRegExp(value), "i").test(output));
  const titleToKeep = embeddedTitles.find((value) => protectedTitles.has(value.toLocaleLowerCase())) ?? embeddedTitles[0];

  for (const title of embeddedTitles) {
    if (title === titleToKeep) continue;
    output = output.replace(new RegExp(escapeRegExp(title), "gi"), " ");
  }

  output = output.replace(/\s+/g, " ").trim().split(" ").slice(0, 20).join(" ");
  return enforceSearchQueryIntent(output || deterministicSearchQuery(messages, releaseFilter), messages, releaseFilter);
}

export function inferGameBrainGenres(messages: ChatMessage[], query: string, keywords: string[] = []): string[] {
  const text = `${messages.filter((message) => message.role === "user").map((message) => message.content).join(" ")} ${query} ${keywords.join(" ")}`;
  const mappings: [RegExp, string][] = [
    [/(?:动作|战斗|\baction\b|\bcombat\b)/i, "action"],
    [/(?:冒险|\badventure\b)/i, "adventure"],
    [/(?:射击|第一人称射击|第三人称射击|\bshooter\b|\bFPS\b|\bTPS\b)/i, "shooter"],
    [/(?:角色扮演|\bRPG\b|role[ -]?playing)/i, "role_playing"],
    [/(?:砍杀|hack[ -]?and[ -]?slash)/i, "hack_and_slash"],
    [/(?:策略|\bstrategy\b)/i, "strategy"],
    [/(?:生存|\bsurvival\b)/i, "survival"],
    [/(?:格斗|\bfighting\b)/i, "fighting"],
    [/(?:竞速|赛车|\bracing\b)/i, "racing"],
    [/(?:模拟|\bsimulation\b)/i, "simulation"],
    [/(?:解谜|\bpuzzle\b)/i, "puzzle"],
    [/(?:平台跳跃|\bplatformer\b)/i, "platformer"],
  ];
  return mappings.filter(([pattern]) => pattern.test(text)).map(([, value]) => value).slice(0, 4);
}

export function inferGameBrainThemes(messages: ChatMessage[], query: string, keywords: string[] = []): string[] {
  const text = `${messages.filter((message) => message.role === "user").map((message) => message.content).join(" ")} ${query} ${keywords.join(" ")}`;
  const mappings: [RegExp, string][] = [
    [/(?:黑暗奇幻|dark[ -]?fantasy)/i, "dark_fantasy"],
    [/(?:奇幻|\bfantasy\b)/i, "fantasy"],
    [/(?:恐怖|\bhorror\b)/i, "horror"],
    [/(?:历史|\bhistorical\b)/i, "historical"],
    [/(?:末日后|后启示录|post[ -]?apocalyptic)/i, "post_apocalyptic"],
  ];
  const themes = mappings.filter(([pattern]) => pattern.test(text)).map(([, value]) => value);
  return themes.filter((value) => value !== "fantasy" || !themes.includes("dark_fantasy")).slice(0, 3);
}

export function normalizeReleaseFilter(value: unknown): ReleaseFilter {
  if (value === "recent") return "last5";
  if (value === "classic") return "before2020";
  return value === "last1" || value === "last3" || value === "last5" || value === "before2020" || value === "before2010"
    ? value
    : "all";
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
