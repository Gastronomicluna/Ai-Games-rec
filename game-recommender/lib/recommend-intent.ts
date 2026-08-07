import type { ChatMessage, Platform, ReleaseFilter } from "./types";

export type RecommendationMode = "exact_lookup" | "similar_games" | "discovery";

export interface ReleaseConstraint {
  from: string | null;
  to: string | null;
  includeUnknown: boolean;
  source: "ui" | "user_text" | "default";
  label: string;
}

export interface RecommendationIntent {
  mode: RecommendationMode;
  referenceGames: string[];
  companies: string[];
  release: ReleaseConstraint;
  recencyPreference: "none" | "prefer_newest";
  platforms: Platform[];
  playModes: string[];
  price: { freeOnly: boolean; maxUsd: number | null };
  rawText: string;
}

const QUOTED_GAME_PATTERN = /[\u201c\u300c\u300a\u3010]([^\u201d\u300d\u300b\u3011]{1,80})[\u201d\u300d\u300b\u3011]/g;
const ENGLISH_REFERENCE_PATTERN = /(?:similar\s+to|around|inspired\s+by|games?\s+like)\s+([A-Za-z][A-Za-z0-9 &'!:.-]{1,80})/gi;
const EXACT_LOOKUP_PATTERN = /(?:\u641c\u7d22|\u67e5\u627e|\u627e\u4e00\u4e0b|\u67e5\u4e00\u4e0b|\blook\s*up\b|\bfind\b|\bsearch\b)/i;
const SIMILAR_PATTERN = /(?:\u7c7b\u4f3c|\u50cf|\u76f8\u4f3c|\u63a5\u8fd1|similar\s+to|similar\s+games?|games?\s+like)/i;
const PREFER_NEWEST_PATTERN = /(?:\u8d8a\u65b0\u8d8a\u597d|\u8d8a\u65b0|\u6700\u65b0|\u65b0\u4e00\u70b9|\u5c3d\u91cf\u65b0|\bnewest\b|\blatest\b|\bas new as possible\b)/i;

function platformConstraints(text: string): Platform[] {
  const result: Platform[] = [];
  if (/(?:\bsteam\b|Steam\s*\u4e0a|PC\s*\u7248)/i.test(text)) result.push("steam");
  if (/(?:\bpsn\b|playstation|PS[345]\b|\u7d22\u5c3c\u4e3b\u673a)/i.test(text)) result.push("psn");
  if (/(?:nintendo\s*switch|\bswitch\b|\bNS\b|\u4efb\u5929\u5802\u4e3b\u673a)/i.test(text)) result.push("ns");
  if (/(?:\u624b\u6e38|\u624b\u673a\u6e38\u620f|\u79fb\u52a8\u7aef|\u624b\u673a\u7aef|\bandroid\b|\bios\b|\biphone\b|\bipad\b|\bmobile\s+games?\b)/i.test(text)) result.push("mobile");
  return result;
}

function playModeConstraints(text: string): string[] {
  const modes: string[] = [];
  const hasCoop = /(?:\u5408\u4f5c|\u534f\u4f5c|\bco[ -]?op\b|cooperative)/i.test(text);
  const hasTwoPlayers = /(?:\u53cc\u4eba|\u4e24\u4e2a?\u4eba|2\s*\u4e2a?\u4eba|two[ -]?player|2[ -]?player)/i.test(text);
  if (hasCoop) modes.push("co_op");
  if (hasTwoPlayers) modes.push("two_players");
  if (/(?:\u672c\u5730\u5408\u4f5c|\u672c\u5730\u8054\u673a|\u540c\u5c4f|\u5206\u5c4f|local\s+co[ -]?op|couch\s+co[ -]?op)/i.test(text)) modes.push("local_co_op");
  if (/(?:\u5728\u7ebf\u5408\u4f5c|\u7f51\u7edc\u5408\u4f5c|\u8054\u673a|online\s+co[ -]?op)/i.test(text)) modes.push("online_co_op");
  if (!hasCoop && /(?:\u591a\u4eba|multiplayer)/i.test(text)) modes.push("multiplayer");
  if (/(?:\u5355\u4eba|single[ -]?player)/i.test(text)) modes.push("single_player");
  return Array.from(new Set(modes));
}

function priceConstraint(text: string): { freeOnly: boolean; maxUsd: number | null } {
  const freeOnly = /(?:\u53ea\u8981\u514d\u8d39|\u5fc5\u987b\u514d\u8d39|\u514d\u8d39\u6e38\u620f|\bfree(?: to play)?\b)/i.test(text);
  if (freeOnly) return { freeOnly: true, maxUsd: 0 };
  const match = text.match(/(?:\u4f4e\u4e8e|\u4e0d\u8d85\u8fc7|\u4fbf\u5b9c\u4e8e|under|max(?:imum)?)[\s$]*(5|15|25|40)\s*(?:\u7f8e\u5143|usd|dollars?)?/i);
  return { freeOnly: false, maxUsd: match ? Number(match[1]) : null };
}

const COMPANY_ALIASES: { canonical: string; pattern: RegExp }[] = [
  { canonical: "NetEase", pattern: /(?:\u7f51\u6613(?:\u6e38\u620f)?|\bnetease(?: games)?\b)/i },
  { canonical: "Tencent", pattern: /(?:\u817e\u8baf(?:\u6e38\u620f)?|\btencent(?: games)?\b)/i },
  { canonical: "Nintendo", pattern: /(?:\u4efb\u5929\u5802|\bnintendo\b)/i },
  { canonical: "Sony", pattern: /(?:\u7d22\u5c3c|\bsony(?: interactive entertainment)?\b)/i },
  { canonical: "Microsoft", pattern: /(?:\u5fae\u8f6f|\bmicrosoft(?: gaming)?\b|\bxbox game studios\b)/i },
  { canonical: "Ubisoft", pattern: /(?:\u80b2\u78a7|\bubisoft\b)/i },
  { canonical: "Electronic Arts", pattern: /(?:\u827a\u7535|\belectronic arts\b|\bea games\b)/i },
  { canonical: "Capcom", pattern: /(?:\u5361\u666e\u7a7a|\bcapcom\b)/i },
  { canonical: "HoYoverse", pattern: /(?:\u7c73\u54c8\u6e38|\bmihoyo\b|\bhoyoverse\b)/i },
];

function companyConstraints(text: string): string[] {
  const companies = COMPANY_ALIASES.filter((company) => company.pattern.test(text)).map((company) => company.canonical);
  const genericPatterns = [
    /([\p{L}\p{N}&.'-]{2,40})(?:\u516c\u53f8)?(?:\u51fa\u54c1|\u5f00\u53d1|\u53d1\u884c|\u5236\u4f5c)/giu,
    /(?:games?\s+)?(?:by|from|developed\s+by|published\s+by|produced\s+by)\s+([\p{L}\p{N}&.' -]{2,50})/giu,
  ];
  for (const pattern of genericPatterns) {
    for (const match of text.matchAll(pattern)) {
      const company = match[1]
        .replace(/^(?:(?:\u6211\u8ba9\u5176|\u5e2e\u6211|\u7ed9\u6211|\u6211\u60f3\u8981|\u6211\u60f3\u73a9|\u6211\u60f3|\u60f3\u8981|\u60f3\u73a9|\u8bf7|\u9ebb\u70e6|\u63a8\u8350|\u627e|\u4e00\u4e9b|\u7531|\u6765\u81ea|\u5176))+/u, "")
        .trim();
      if (company.length >= 2 && company.length <= 50 && !/^(?:game|games|\u6e38\u620f)$/i.test(company)) {
        const canonical = COMPANY_ALIASES.find((alias) => alias.pattern.test(company))?.canonical ?? company;
        companies.push(canonical);
      }
    }
  }
  return Array.from(new Map(companies.map((company) => [company.toLocaleLowerCase(), company])).values()).slice(0, 6);
}

export function normalizeGameTitle(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function cleanName(value: string): string {
  return value.replace(/[\u3002\uff0c,;\uff1b\uff1a!?\uff01\uff1f]+$/g, "").replace(/\s+/g, " ").trim();
}

function uniqueNames(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const name = cleanName(value);
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key) || name.length > 80) continue;
    seen.add(key);
    output.push(name);
  }
  return output.slice(0, 8);
}

function cleanTraitReference(value: string): string {
  let result = cleanName(value.replace(/^[\s\u300a\u300c\u3010]+|[\s\u300b\u300d\u3011]+$/g, ""));
  const conversationalPrefix = /^(?:\u6211\u60f3(?:\u8981|\u627e|\u73a9)?|\u60f3(?:\u8981|\u627e|\u73a9)|\u8bf7(?:\u5e2e\u6211)?|\u5e2e\u6211|\u7ed9\u6211|\u63a8\u8350|\u5bfb\u627e|\u627e(?:\u4e00\u4e9b|\u4e00\u4e2a)?|\u7c7b\u4f3c|\u50cf|\u53c2\u8003(?:\u4e8e)?)+/u;
  while (conversationalPrefix.test(result)) result = result.replace(conversationalPrefix, "").trim();
  return result.replace(/\u7684(?:\u624b\u6e38|\u624b\u673a\u6e38\u620f|\u6e38\u620f)$/u, "").replace(/(?:\u90a3\u6837|\u8fd9\u6837|\u98ce\u683c)$/u, "").trim();
}

function extractTraitReferenceGames(text: string): string[] {
  const traits = "(?:\u753b\u98ce|\u7f8e\u672f|\u89c6\u89c9|\u827a\u672f\u98ce\u683c|\u6c1b\u56f4|\u9898\u6750|\u73a9\u6cd5|\u673a\u5236|\u6218\u6597\u7cfb\u7edf|visual\\s+style|art\\s+style|gameplay|mechanics)";
  const patterns = [
    new RegExp(`${traits}(?:\\s*(?:\u548c|\u4e0e|\u53ca|\u3001)\\s*${traits})*\\s*(?:\u7c7b\u4f3c|\u50cf|\u53c2\u8003(?:\u4e8e)?|similar\\s+to)\\s*[\u300a\u300c\u3010]?([^\u300b\u300d\u3011\uff0c\u3002,.!?\n]{2,60})`, "giu"),
    new RegExp(`(?:\u7c7b\u4f3c|\u50cf|\u53c2\u8003(?:\u4e8e)?|similar\\s+to)\\s*[\u300a\u300c\u3010]?([^\u300b\u300d\u3011\uff0c\u3002,.!?\n]{2,60}?)[\u300b\u300d\u3011]?(?=\\s*(?:\u7684)?${traits}|[\uff0c\u3002,.!?\n]|$)`, "giu"),
    new RegExp(`(?:^|[\uff0c\u3002,.!?\n])\\s*[\u300a\u300c\u3010]?([^\u300b\u300d\u3011\uff0c\u3002,.!?\n]{2,60}?)[\u300b\u300d\u3011]?(?=\\s*(?:\u7684)?${traits})`, "giu"),
  ];
  const values: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = cleanTraitReference(match[1]);
      if (value.length >= 2 && value.length <= 80) values.push(value);
    }
  }
  return uniqueNames(values);
}

function isoYear(year: number): string {
  return `${year.toString().padStart(4, "0")}-01-01`;
}

function formatLabel(from: string | null, to: string | null): string {
  if (from && to) return `${from.slice(0, 4)}-${to.slice(0, 4)}`;
  if (from) return `${from.slice(0, 4)}+`;
  if (to) return `<${to.slice(0, 4)}`;
  return "all";
}

export function releaseConstraintFromFilter(filter: ReleaseFilter, now = new Date()): ReleaseConstraint {
  const currentYear = now.getFullYear();
  if (filter === "recent" || filter === "last5") {
    const from = isoYear(currentYear - 4);
    return { from, to: null, includeUnknown: false, source: "ui", label: formatLabel(from, null) };
  }
  if (filter === "classic" || filter === "before2020") {
    const to = isoYear(2020);
    return { from: null, to, includeUnknown: false, source: "ui", label: formatLabel(null, to) };
  }
  if (filter === "last1") {
    const from = isoYear(currentYear - 1);
    return { from, to: null, includeUnknown: false, source: "ui", label: formatLabel(from, null) };
  }
  if (filter === "last3") {
    const from = isoYear(currentYear - 2);
    return { from, to: null, includeUnknown: false, source: "ui", label: formatLabel(from, null) };
  }
  if (filter === "before2010") {
    const to = isoYear(2010);
    return { from: null, to, includeUnknown: false, source: "ui", label: formatLabel(null, to) };
  }
  return { from: null, to: null, includeUnknown: true, source: "default", label: "all" };
}

function parseReleaseFromText(text: string, now = new Date()): ReleaseConstraint | null {
  const range = text.match(/(\d{4})\s*(?:\u5e74)?\s*(?:\u5230|\u81f3|-|~|\uff5e)\s*(\d{4})\s*(?:\u5e74)?/);
  if (range) {
    const from = isoYear(Number(range[1]));
    const to = isoYear(Number(range[2]) + 1);
    return { from, to, includeUnknown: false, source: "user_text", label: formatLabel(from, to) };
  }

  const after = text.match(/(\d{4})\s*(?:\u5e74)?\s*(?:\u4ee5\u540e|\u4e4b\u540e|\u8d77|\u53ca\u4ee5\u540e|\u53ca\u4e4b\u540e|or newer|and newer)/i);
  if (after) {
    const from = isoYear(Number(after[1]));
    return { from, to: null, includeUnknown: false, source: "user_text", label: formatLabel(from, null) };
  }

  const before = text.match(/(\d{4})\s*(?:\u5e74)?\s*(?:\u4ee5\u524d|\u4e4b\u524d|\u524d|\u53ca\u4ee5\u524d|\u53ca\u4e4b\u524d|or older|and older)/i);
  if (before) {
    const to = isoYear(Number(before[1]));
    return { from: null, to, includeUnknown: false, source: "user_text", label: formatLabel(null, to) };
  }

  const recent = text.match(/(?:\u8fd1|\u6700\u8fd1)\s*(\d+)\s*\u5e74/);
  if (recent) {
    const years = Math.max(1, Number(recent[1]));
    // Product semantics: "近1年" spans this and the previous calendar year;
    // larger presets include exactly N calendar years including this year.
    const offset = years === 1 ? 1 : years - 1;
    const from = isoYear(now.getFullYear() - offset);
    return { from, to: null, includeUnknown: false, source: "user_text", label: formatLabel(from, null) };
  }

  if (/(?:\u65b0\u6e38\u620f|\u65b0\u4f5c|\brecent\b|\bnew releases?\b)/i.test(text)) {
    const from = isoYear(now.getFullYear() - 5);
    return { from, to: null, includeUnknown: false, source: "user_text", label: formatLabel(from, null) };
  }
  if (/(?:\u8001\u6e38\u620f|\u7ecf\u5178|\bclassic\b|\bold games?\b)/i.test(text)) {
    const to = isoYear(2020);
    return { from: null, to, includeUnknown: false, source: "user_text", label: formatLabel(null, to) };
  }
  return null;
}

function extractReferenceGames(messages: ChatMessage[], favoriteGames: string[]): string[] {
  const values = [...favoriteGames];
  const text = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
  for (const match of text.matchAll(QUOTED_GAME_PATTERN)) values.push(match[1]);
  for (const match of text.matchAll(ENGLISH_REFERENCE_PATTERN)) values.push(match[1]);
  values.push(...extractTraitReferenceGames(text));
  return uniqueNames(values);
}

function exactLookupName(messages: ChatMessage[], references: string[]): string | null {
  if (references.length > 0) return references[0];
  const latest = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  const match = latest.match(/(?:\u641c\u7d22|\u67e5\u627e|\u627e\u4e00\u4e0b|\u67e5\u4e00\u4e0b)\s*([^\uff0c\u3002,.!?\uff01\uff1f\n]{2,80})/);
  return match ? cleanName(match[1].replace(/(?:\u8fd9\u4e2a|\u8fd9\u6b3e|\u8fd9\u4e2a\u6e38\u620f)$/u, "")) : null;
}

export function parseRecommendationIntent(
  messages: ChatMessage[],
  favoriteGames: string[] = [],
  releaseFilter: ReleaseFilter = "all",
  now = new Date()
): RecommendationIntent {
  const rawText = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
  const referenceGames = extractReferenceGames(messages, favoriteGames);
  const textRelease = parseReleaseFromText(rawText, now);
  const uiRelease = releaseConstraintFromFilter(releaseFilter, now);
  const release = releaseFilter === "all" ? (textRelease ?? uiRelease) : uiRelease;
  const exact = EXACT_LOOKUP_PATTERN.test(rawText) && !SIMILAR_PATTERN.test(rawText);
  const mode: RecommendationMode = exact ? "exact_lookup" : referenceGames.length > 0 ? "similar_games" : "discovery";
  const exactName = exactLookupName(messages, referenceGames);
  return {
    mode,
    referenceGames: exact && exactName ? [exactName] : referenceGames,
    companies: companyConstraints(rawText),
    release,
    recencyPreference: PREFER_NEWEST_PATTERN.test(rawText) ? "prefer_newest" : "none",
    platforms: platformConstraints(rawText),
    playModes: playModeConstraints(rawText),
    price: priceConstraint(rawText),
    rawText,
  };
}

function dateValue(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value > 10_000 ? value : Date.UTC(value, 0, 1);
  const match = value.match(/^(\d{4})(?:-(\d{2})-(\d{2}))?/);
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return Date.UTC(Number(match[1]), match[2] ? Number(match[2]) - 1 : 0, match[3] ? Number(match[3]) : 1);
}

export function matchesReleaseConstraint(value: number | string | null | undefined, constraint: ReleaseConstraint): boolean {
  const timestamp = dateValue(value);
  if (timestamp === null) return constraint.includeUnknown;
  if (constraint.from && timestamp < Date.parse(constraint.from)) return false;
  if (constraint.to && timestamp >= Date.parse(constraint.to)) return false;
  return true;
}

export function releaseConstraintText(constraint: ReleaseConstraint): string {
  if (constraint.from && constraint.to) return `release between ${constraint.from} and ${constraint.to}`;
  if (constraint.from) return `release on or after ${constraint.from}`;
  if (constraint.to) return `release before ${constraint.to}`;
  return "release date unrestricted";
}
