"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ChatDock from "@/components/ChatDock";
import GameModal from "@/components/GameModal";
import HomeView from "@/components/HomeView";
import ResultsView from "@/components/ResultsView";
import type { ChatMessage, Game, Platform, PreviousRecommendation, RecommendResponse, ReleaseFilter } from "@/lib/types";

const STORAGE_KEY = "wanshenme-session-v3";

interface SessionState {
  messages: ChatMessage[];
  games: Game[];
  excludedIds: number[];
  platforms: Platform[];
  favoriteGames?: string[];
  releaseFilter?: ReleaseFilter;
  count: number;
}

function isStoredGame(value: unknown): value is Game {
  if (!value || typeof value !== "object") return false;
  const game = value as Partial<Game>;
  return (
    typeof game.id === "number" &&
    typeof game.name === "string" &&
    Array.isArray(game.platformNames) &&
    typeof game.reason === "string" &&
    typeof game.storeUrl === "string"
  );
}

function loadSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null;
    const messages = parsed.messages.filter(
      (message): message is ChatMessage =>
        Boolean(message) &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string"
    );
    const games = Array.isArray(parsed.games) ? parsed.games.filter(isStoredGame) : [];
      const platforms = Array.isArray(parsed.platforms)
    ? parsed.platforms.filter((p): p is Platform => p === "steam" || p === "psn" || p === "ns")
    : [];
  const excludedIds = Array.isArray(parsed.excludedIds)
    ? parsed.excludedIds.filter((id): id is number => Number.isInteger(id) && id > 0)
    : [];
  if (messages.length === 0) return null;
  return { messages, games, excludedIds, platforms, favoriteGames: Array.isArray(parsed.favoriteGames) ? parsed.favoriteGames.filter((value): value is string => typeof value === "string").slice(0, 8) : [], releaseFilter: parsed.releaseFilter === "last1" || parsed.releaseFilter === "last3" || parsed.releaseFilter === "last5" || parsed.releaseFilter === "before2020" || parsed.releaseFilter === "before2010" ? parsed.releaseFilter : "all", count: typeof parsed.count === "number" ? parsed.count : 6 };
  } catch {
    return null;
  }
}

export default function Page() {
  const [view, setView] = useState<"home" | "results">("home");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const gamesRef = useRef(games);
  gamesRef.current = games;
  const [excludedIds, setExcludedIds] = useState<number[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [favoriteGames, setFavoriteGames] = useState<string[]>([]);
  const [releaseFilter, setReleaseFilter] = useState<ReleaseFilter>("all");
  const releaseFilterRef = useRef<ReleaseFilter>(releaseFilter);
  releaseFilterRef.current = releaseFilter;
  const platformsRef = useRef(platforms);
  platformsRef.current = platforms;
  const [count, setCount] = useState(6);
  const countRef = useRef(count);
  countRef.current = count;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Game | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const requestVersionRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const session = loadSession();
    if (session) {
      setMessages(session.messages);
      setGames(session.games);
            setExcludedIds(session.excludedIds);
      setPlatforms(session.platforms ?? []);
      setCount(session.count ?? 6);
      setView("results");
    }
    setHydrated(true);
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (messages.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, games, excludedIds, platforms, favoriteGames, releaseFilter, count }));
    }
  }, [messages, games, excludedIds, platforms, favoriteGames, releaseFilter, count, hydrated]);

  const requestRecommend = useCallback(
    async (
      nextMessages: ChatMessage[],
      nextExcluded: number[],
      appendExcluded: boolean,
      rollbackMessages?: ChatMessage[],
      contextGames: Game[] = []
    ): Promise<boolean> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestVersion = ++requestVersionRef.current;
      setLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/recommend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: nextMessages,
            excludeIds: nextExcluded,
            platforms: platformsRef.current,
            count: countRef.current,
            releaseFilter: releaseFilterRef.current,
            previousGames: contextGames.slice(0, 40).map((game): PreviousRecommendation => ({
              id: game.id,
              name: game.name,
              platformNames: game.platformNames,
              genres: game.genres,
              tags: game.tags,
              playerModes: game.playerModes,
              reason: game.reason,
            })),
          }),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error ?? "推荐失败，请稍后重试");
        const result = data as RecommendResponse;
        if (!Array.isArray(result.games) || result.games.length === 0) {
          throw new Error("这次没有找到合适的游戏，请换个描述重试");
        }
        if (requestVersion !== requestVersionRef.current) return false;

        setGames(result.games);
        setMessages([...nextMessages, { role: "assistant", content: result.reply }]);
        const batchIds = result.games.map((game) => game.id);
        setExcludedIds(appendExcluded ? Array.from(new Set([...nextExcluded, ...batchIds])) : batchIds);
        setView("results");
        return true;
      } catch (caught) {
        if (controller.signal.aborted || requestVersion !== requestVersionRef.current) return false;
        if (rollbackMessages) setMessages(rollbackMessages);
        setError(caught instanceof Error ? caught.message : "网络异常，请稍后重试");
        return false;
      } finally {
        if (requestVersion === requestVersionRef.current) {
          setLoading(false);
          abortRef.current = null;
        }
      }
    },
    []
  );

  const handleSend = useCallback(
    async (text: string) => {
      const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
      setMessages(nextMessages);
      return requestRecommend(nextMessages, [], false, messages, gamesRef.current);
    },
    [messages, requestRecommend]
  );

  const handleRefreshBatch = useCallback(() => {
    void requestRecommend(messages, excludedIds, true, undefined, gamesRef.current);
  }, [messages, excludedIds, requestRecommend]);

  const handleApplyPreferences = useCallback((nextFavorites: string[], nextPlatforms: Platform[], nextReleaseFilter: ReleaseFilter) => {
    const favoriteText = nextFavorites.length > 0 ? `我喜欢《${nextFavorites.join("》《")}》。` : "我没有指定喜欢的游戏。";
    const nextMessages: ChatMessage[] = [
      ...messages,
      {
        role: "user",
        content: `请以本次更新后的偏好为准，忽略之前的喜好游戏选择。${favoriteText}`,
      },
    ];
    platformsRef.current = nextPlatforms;
    releaseFilterRef.current = nextReleaseFilter;
    setPlatforms(nextPlatforms);
    setReleaseFilter(nextReleaseFilter);
    setFavoriteGames(nextFavorites);
    setMessages(nextMessages);
    void requestRecommend(nextMessages, [], false, messages, gamesRef.current);
  }, [messages, requestRecommend]);

  const handleReset = useCallback(() => {
    requestVersionRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setGames([]);
        setExcludedIds([]);
    setPlatforms([]);
    setSelected(null);
    setLoading(false);
    setError(null);
    setView("home");
  }, []);

  return (
    <>
      {view === "home" ? (
        <HomeView loading={loading} error={error} platforms={platforms} onPlatformsChange={setPlatforms} favoriteGames={favoriteGames} onFavoriteGamesChange={setFavoriteGames} releaseFilter={releaseFilter} onReleaseFilterChange={setReleaseFilter} count={count} onCountChange={setCount} onSubmit={handleSend} />
      ) : (
        <div className="flex min-h-screen flex-col">
          <div className="flex-1">
            <ResultsView
              games={games}
              loading={loading}
              error={error}
              count={count}
              onCountChange={(c: number) => { countRef.current = c; setCount(c); void requestRecommend(messages, excludedIds, true, undefined, gamesRef.current); }}
              favoriteGames={favoriteGames}
              onFavoriteGamesChange={setFavoriteGames}
              platforms={platforms}
              onPlatformsChange={setPlatforms}
              releaseFilter={releaseFilter}
              onReleaseFilterChange={setReleaseFilter}
              onApplyPreferences={handleApplyPreferences}
              onRefreshBatch={handleRefreshBatch}
              onSelectGame={setSelected}
            />
          </div>
          <ChatDock messages={messages} loading={loading} onSend={handleSend} onReset={handleReset} />
        </div>
      )}
      {selected && <GameModal game={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

