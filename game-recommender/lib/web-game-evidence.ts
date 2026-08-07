export interface WebListEvidence {
  title: string;
  url: string;
  snippet: string;
}

const NON_OFFICIAL_GAME_WEBSITE_DOMAINS = [
  "youtube.com", "youtu.be", "facebook.com", "instagram.com", "tiktok.com", "twitter.com", "x.com",
  "reddit.com", "discord.com", "discord.gg", "wikipedia.org", "fandom.com", "steamcommunity.com",
  "store.steampowered.com", "play.google.com", "apps.apple.com", "twitch.tv", "bilibili.com",
  "ign.com", "gamespot.com", "polygon.com", "pcgamer.com", "rockpapershotgun.com", "pocketgamer.com",
  "gamerant.com", "thegamer.com", "game8.co", "mobygames.com", "rawg.io", "metacritic.com",
  "apkpure.com", "uptodown.com", "taptap.io", "tap.io", "softonic.com", "appbrain.com",
  "minireview.io", "sketchfab.com", "itch.io", "gamejolt.com", "miniplay.com", "playhop.com",
  "gematsu.com", "backloggd.com", "gamedeveloper.com",
];

export function isAllowedOfficialGameWebsite(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const hostname = url.hostname.toLocaleLowerCase().replace(/^www\./, "");
    return !NON_OFFICIAL_GAME_WEBSITE_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function normalizeName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isStandaloneTitle(name: string): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  if (wordCount > 10) return false;
  const lowercaseProseWords = words.filter((word) => /^[a-z][a-z-]+$/.test(word) && !/^(?:a|an|and|as|at|by|for|from|in|of|on|or|the|to|vs|with)$/.test(word));
  if (wordCount > 6 && lowercaseProseWords.length >= 3) return false;
  return !/(friend[?'s]* pass|demo|playtest|soundtrack|dedicated server|benchmark|artbook|companion|editor|test server|\bdlc\b|season pass|privacy policy|terms of (?:use|service)|system requirements?|required environment|copyright|googleplay|app store|image\s*\d+|\[\.\.\.\]|>>)/i.test(name);
}

export function extractGameNamesFromWebLists(results: WebListEvidence[], references: string[]): { name: string; similarityReason: string; sourceUrls: string[] }[] {
  const referenceKeys = new Set(references.map(normalizeName));
  const found = new Map<string, { name: string; similarityReason: string; sourceUrls: string[] }>();
  const add = (rawName: string, result: WebListEvidence) => {
    const name = rawName
      .replace(/^\s*(?:#?\d+[.):_-]?|[-•✓×]+)\s*/, "")
      .replace(/\s+(?:platform|best for|core mechanic|pros?|cons?)\s*:.*$/i, "")
      .replace(/\s+(?:and more|etc\.?|more)$/i, "")
      .replace(/^["'“”]+|["'“”:.]+$/g, "")
      .trim();
    const key = normalizeName(name);
    if (!key || key.length < 4 || referenceKeys.has(key) || name.length > 80 || !isStandaloneTitle(name)) return;
    if (/(?:#{2,}|\bdownloads?\b|\bdownloadalternatives\b|\bicon\b|\bapk\b|\bsvg\b|^\+|\.\d{3,}|\d+(?:\.\d+)?\s*[km]\s+downloads?)/i.test(name)) return;
    if (/^(?:best|top|games?|alternatives?|similar|android|ios|mobile|play|learn|many characters|steep learning|intense matches)/i.test(name)) return;
    const existing = found.get(key);
    if (existing) {
      if (!existing.sourceUrls.includes(result.url)) existing.sourceUrls.push(result.url);
      return;
    }
    found.set(key, {
      name,
      similarityReason: `${result.title} lists ${name} in the requested recommendation context.`,
      sourceUrls: [result.url],
    });
  };

  for (const result of results) {
    for (const match of result.snippet.matchAll(/#{2,}\s*\d+[.)]\s*([^#\n]{2,80})/g)) add(match[1], result);
    for (const match of result.snippet.matchAll(/(?:^|[\s·|])\d+[.)]\s*([^·|,;\n]{2,80})/g)) add(match[1], result);
    for (const match of result.snippet.matchAll(/(?:are|choose|include|includes|such as)\s*:\s*([^\n.]{4,500})/gi)) {
      for (const part of match[1].split(/\s*[|·,;]\s*/)) add(part, result);
    }
  }
  return Array.from(found.values()).slice(0, 12);
}
