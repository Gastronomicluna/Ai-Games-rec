"use client";

import { Calendar, Clock3, Monitor, ThumbsUp } from "lucide-react";
import type { Game } from "@/lib/types";

function formatCount(n: number): string {
  return n >= 10000 ? `${Math.round(n / 10000)}万` : String(n);
}

function platformSummary(platforms: string[]): string {
  if (platforms.length === 0) return "平台未知";
  if (platforms.length <= 2) return platforms.join(" / ");
  return `${platforms.slice(0, 2).join(" / ")} +${platforms.length - 2}`;
}

export default function GameCard({ game, onSelect }: { game: Game; onSelect: (g: Game) => void }) {
  return (
    <button
      onClick={() => onSelect(game)}
      className="group flex flex-col overflow-hidden rounded-lg border border-ink/8 bg-white text-left transition duration-200 hover:-translate-y-1 hover:border-brand-2/60 hover:shadow-[0_12px_32px_-12px_rgba(59,180,209,0.45)]"
    >
      <div className="relative aspect-[460/215] w-full overflow-hidden bg-brand-2/10">
        {game.headerImage ? (
          <img
            src={game.headerImage}
            alt={game.name}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]"
          />
        ) : (
          <div className="bg-brand-gradient flex h-full items-center justify-center px-6 text-center font-bold text-white">
            {game.name}
          </div>
        )}
        <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
          <span className={`rounded px-2 py-0.5 text-xs font-bold text-white ${game.price.formatted === "免费" ? "bg-brand-2-strong" : "bg-ink/75"}`}>
            {game.price.formatted}
          </span>
          {game.price.discountPercent > 0 && (
            <span className="rounded bg-brand px-1.5 py-0.5 text-xs font-bold text-white">
              -{game.price.discountPercent}%
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <h3 className="truncate text-base font-bold">{game.name}</h3>

        <p className="flex items-start gap-1.5 text-sm leading-relaxed text-ink/75">
          <span className="mt-0.5 shrink-0 text-brand">▸</span>
          <span className="line-clamp-3">{game.reason}</span>
        </p>

        <div className="flex flex-wrap gap-1.5">
          {game.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded bg-paper px-2 py-0.5 text-xs text-ink/60 ring-1 ring-ink/8">
              {tag}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink/50">
          <span className="flex items-center gap-1">
            <Monitor size={13} />
            {platformSummary(game.platformNames)}
          </span>
          <span className="flex items-center gap-1">
            <Clock3 size={13} />
            {game.playtimeHours === null ? "时长未知" : `约 ${game.playtimeHours} 小时`}
          </span>
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-ink/50">
          {game.review ? (
            <span className="flex items-center gap-1 text-brand-2-strong">
              <ThumbsUp size={13} />
              {game.review.source === "steam"
                ? `${game.review.label} ${game.review.positiveRate}% · ${formatCount(game.review.total)}评测`
                : `${game.review.label} · ${formatCount(game.review.total)}评分`}
            </span>
          ) : game.metacritic ? (
            <span className="flex items-center gap-1 text-brand-2-strong">
              <ThumbsUp size={13} /> M 站 {game.metacritic}
            </span>
          ) : (
            <span>评分较少</span>
          )}
          <span className="flex items-center gap-1">
            <Calendar size={13} />
            {game.releaseDate}
          </span>
        </div>
      </div>
    </button>
  );
}
