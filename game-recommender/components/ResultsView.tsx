"use client";

import { useEffect, useMemo, useState } from "react";
import { Gamepad2, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { sortGames, type SortMode } from "@/lib/game-utils";
import type { AgentTraceEvent, Game, Platform, ReleaseFilter } from "@/lib/types";
import GameSearchInput from "./GameSearchInput";
import GameCard from "./GameCard";
import PixelLogo from "./PixelLogo";
import AgentTracePanel from "./AgentTracePanel";

const RELEASE_OPTIONS: { key: ReleaseFilter; label: string }[] = [
  { key: "all", label: "不限" },
  { key: "last1", label: "近1年" },
  { key: "last3", label: "近3年" },
  { key: "last5", label: "近5年" },
  { key: "before2020", label: "2020年前" },
  { key: "before2010", label: "2010年前" },
];

const PLATFORM_OPTIONS: { key: Platform; label: string; icon: typeof Monitor }[] = [
  { key: "steam", label: "Steam", icon: Monitor },
  { key: "psn", label: "PSN", icon: Gamepad2 },
  { key: "ns", label: "NS", icon: Gamepad2 },
  { key: "mobile", label: "\u624B\u6E38", icon: Smartphone },
];

const SORT_OPTIONS: { key: SortMode; label: string }[] = [
  { key: "match", label: "匹配度" },
  { key: "rating", label: "评分" },
  { key: "release", label: "最新发售" },
  { key: "price", label: "价格" },
];

const LOADING_STEPS = ["正在理解你的需求…", "正在检索 GameBrain 与 Steam 游戏库…", "AI 正在核对平台并撰写推荐理由…"];

export default function ResultsView({
  games,
  loading,
  error,
  count,
  onCountChange,
  onRefreshBatch,
  onSelectGame,
  favoriteGames,
  onFavoriteGamesChange,
  platforms,
  onPlatformsChange,
  onApplyPreferences,
  releaseFilter,
  onReleaseFilterChange,
  agentTrace,
}: {
  games: Game[];
  loading: boolean;
  error: string | null;
  count: number;
  onCountChange: (c: number) => void;
  onRefreshBatch: () => void;
  onSelectGame: (game: Game) => void;
  favoriteGames: string[];
  onFavoriteGamesChange: (games: string[]) => void;
  platforms: Platform[];
  onPlatformsChange: (platforms: Platform[]) => void;
  onApplyPreferences: (favoriteGames: string[], platforms: Platform[], releaseFilter: ReleaseFilter) => void;
  releaseFilter: ReleaseFilter;
  onReleaseFilterChange: (filter: ReleaseFilter) => void;
  agentTrace: AgentTraceEvent[];
}) {
  const [sort, setSort] = useState<SortMode>("match");
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!loading) return;
    setStep(0);
    const timer = setInterval(() => setStep((value) => Math.min(value + 1, LOADING_STEPS.length - 1)), 6000);
    return () => clearInterval(timer);
  }, [loading]);

  const sorted = useMemo(() => sortGames(games, sort), [games, sort]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-6 sm:px-6">
      <header className="flex items-center justify-between py-4">
        <div className="flex items-center gap-2">
          <PixelLogo size={22} />
          <span className="text-base font-bold">游戏雷达</span>
          <span className="hidden rounded border border-brand-2 px-1.5 py-0.5 text-xs text-brand-2-strong sm:inline">
            AI 游戏推荐
          </span>
        </div>
        <p className="text-sm text-ink/50">{loading ? "推荐生成中…" : `累计 ${games.length} 款候选游戏`}</p>
      </header>

      <section className="mb-5 rounded-lg border border-ink/10 bg-white p-3 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <p className="mb-1.5 text-xs font-medium text-ink/55">喜好游戏</p>
            <GameSearchInput chips={favoriteGames} onChipsChange={onFavoriteGamesChange} />
          </div>
          <div className="shrink-0">
            <p className="mb-1.5 text-xs font-medium text-ink/55">平台偏好</p>
            <div className="flex flex-wrap gap-1.5">
              {PLATFORM_OPTIONS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => onPlatformsChange(platforms.includes(key) ? platforms.filter((value) => value !== key) : [...platforms, key])}
                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition ${platforms.includes(key) ? "border-brand bg-brand/10 font-medium text-brand-strong" : "border-ink/15 text-ink/65 hover:border-brand-2"}`}
                >
                  <Icon size={13} />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <p className="mb-1.5 text-xs font-medium text-ink/55">发售时间</p>
            <div className="flex flex-wrap gap-1.5">
              {RELEASE_OPTIONS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => onReleaseFilterChange(key)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${releaseFilter === key ? "border-brand bg-brand/10 font-medium text-brand-strong" : "border-ink/15 text-ink/65 hover:border-brand-2"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => onApplyPreferences(favoriteGames, platforms, releaseFilter)}
            disabled={loading}
            className="shrink-0 rounded-md bg-brand-gradient px-3.5 py-2 text-xs font-semibold text-white transition enabled:hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
          >
            应用偏好并重新推荐
          </button>
        </div>
      </section>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap rounded-lg border border-ink/10 bg-white p-1">
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.key}
              onClick={() => setSort(option.key)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                sort === option.key ? "bg-brand-gradient font-semibold text-white" : "text-ink/60 hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          onClick={onRefreshBatch}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-brand/50 bg-white px-4 py-2 text-sm font-semibold text-brand-strong transition enabled:hover:bg-brand/8 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
                    换一批
        </button>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-ink/45">数量</span>
          <div className="flex rounded-lg border border-ink/10 bg-white p-1">
            {([6, 10, 15, 20] as const).map((n) => (
              <button
                key={n}
                onClick={() => onCountChange(n)}
                className={`rounded-md px-2.5 py-1 text-xs transition ${
                  count === n ? "bg-brand-gradient font-semibold text-white" : "text-ink/60 hover:text-ink"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-600">{error}</p>
      )}

      <AgentTracePanel events={agentTrace} loading={loading} />

      {loading && (
        <p className="mb-4 flex items-center gap-2 text-sm text-ink/55">
          <span className="caret-blink inline-block h-3.5 w-2 bg-brand-2-strong" />
          {games.length > 0
            ? `正在生成新的推荐，当前 ${games.length} 款候选仍可继续查看。`
            : LOADING_STEPS[step]}
        </p>
      )}

      {games.length > 0 ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((game) => (
            <GameCard key={`${game.source}-${game.id}`} game={game} onSelect={onSelectGame} />
          ))}
        </div>
      ) : loading ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: count }).map((_, index) => (
            <div key={index} className="overflow-hidden rounded-lg border border-ink/8 bg-white">
              <div className="aspect-[460/215] animate-pulse bg-brand-2/15" />
              <div className="flex flex-col gap-2.5 p-4">
                <div className="h-4 w-2/3 animate-pulse rounded bg-ink/10" />
                <div className="h-3 w-full animate-pulse rounded bg-ink/8" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-ink/8" />
                <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-ink/8" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-ink/10 bg-white px-6 py-12 text-center text-sm text-ink/55">
          暂时没有找到合适的游戏，请补充平台、类型或游玩人数后重试。
        </div>
      )}
      <p className="mt-8 text-center text-xs text-ink/35">数据来自 GameBrain、Wikidata 与 Steam · <a href="https://gamebrain.co/api" target="_blank" rel="noreferrer" className="underline hover:text-brand-strong">Powered by GameBrain</a></p>
    </div>
  );
}
