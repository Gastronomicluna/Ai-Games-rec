import type { ChatMessage, ReleaseFilter } from "./types";

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
  rawText: string;
}

const QUOTED_GAME_PATTERN = /[\u201c\u300c\u300a\u3010]([^\u201d\u300d\u300b\u3011]{1,80})[\u201d\u300d\u300b\u3011]/g;
const ENGLISH_REFERENCE_PATTERN = /(?:similar\s+to|around|inspired\s+by|games?\s+like)\s+([A-Za-z][A-Za-z0-9 &'!:.-]{1,80})/gi;
const EXACT_LOOKUP_PATTERN = /(?:\u641c\u7d22|\u67e5\u627e|\u627e\u4e00\u4e0b|\u67e5\u4e00\u4e0b|\blook\s*up\b|\bfind\b|\bsearch\b)/i;
const SIMILAR_PATTERN = /(?:\u7c7b\u4f3c|\u50cf|\u76f8\u4f3c|\u63a5\u8fd1|similar\s+to|similar\s+games?|games?\s+like)/i;
const PREFER_NEWEST_PATTERN = /(?:\u8d8a\u65b0\u8d8a\u597d|\u8d8a\u65b0|\u6700\u65b0|\u65b0\u4e00\u70b9|\u5c3d\u91cf\u65b0|\bnewest\b|\blatest\b|\bas new as possible\b)/i;

const COMPANY_ALIASES: { canonical: string; pattern: RegExp }[] = [
  { canonical: "NetEase", pattern: /(?:\u7f51\u6613(?:\u6e38\u620f)?|\bnetease(?: games)?\b)/i },
];

function companyConstraints(text: string): string[] {
  return COMPANY_ALIASES.filter((company) => company.pattern.test(text)).map((company) => company.canonical);
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
    const from = isoYear(now.getFullYear() - Number(recent[1]));
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
    rawText,
  };
}

function dateValue(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value > 10_000 ? value : Date.UTC(value, 0, 1);
  const match = value.match(/^(\d{4})(?:-(\d{2})-(\d{2}))?/);
  if (!match) return null;
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
