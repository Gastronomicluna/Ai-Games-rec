"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { sortGames, type SortMode } from "@/lib/game-utils";
import type { Game } from "@/lib/types";
import GameCard from "./GameCard";
import PixelLogo from "./PixelLogo";

const SORT_OPTIONS: { key: SortMode; label: string }[] = [
  { key: "match", label: "匹配度" },
  { key: "rating", label: "评分" },
  { key: "release", label: "最新发售" },
  { key: "playtime", label: "通关时长" },
  { key: "price", label: "价格" },
];

const LOADING_STEPS = ["正在理解你的需求…", "正在检索 RAWG 与 Steam 游戏库…", "AI 正在核对平台并撰写推荐理由…"];

export default function ResultsView({
  games,
  loading,
  error,
  count,
  onCountChange,
  onRefreshBatch,
  onSelectGame,
}: {
  games: Game[];
  loading: boolean;
  error: string | null;
  count: number;
  onCountChange: (c: number) => void;
  onRefreshBatch: () => void;
  onSelectGame: (game: Game) => void;
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
          <span className="text-base font-bold">玩什么</span>
          <span className="hidden rounded border border-brand-2 px-1.5 py-0.5 text-xs text-brand-2-strong sm:inline">
            AI 游戏推荐
          </span>
        </div>
        <p className="text-sm text-ink/50">{loading ? "推荐生成中…" : `为你找到 ${games.length} 款游戏`}</p>
      </header>

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

      {loading ? (
        <>
          <p className="mb-4 flex items-center gap-2 text-sm text-ink/55">
            <span className="caret-blink inline-block h-3.5 w-2 bg-brand-2-strong" />
            {LOADING_STEPS[step]}
          </p>
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
        </>
      ) : games.length > 0 ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((game) => (
            <GameCard key={`${game.source}-${game.id}`} game={game} onSelect={onSelectGame} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-ink/10 bg-white px-6 py-12 text-center text-sm text-ink/55">
          暂时没有找到合适的游戏，请补充平台、类型或游玩人数后重试。
        </div>
      )}
    </div>
  );
}
