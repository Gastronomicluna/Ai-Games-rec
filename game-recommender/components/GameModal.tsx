"use client";

import { useEffect } from "react";
import {
  Building2,
  Calendar,
  ExternalLink,
  MonitorSmartphone,
  Sparkles,
  Tags,
  ThumbsUp,
  Users,
  X,
} from "lucide-react";
import type { Game } from "@/lib/types";

export default function GameModal({ game, onClose }: { game: Game; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="thin-scroll flex max-h-[92vh] w-full max-w-2xl flex-col overflow-y-auto rounded-t-xl bg-white sm:rounded-lg"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="game-detail-title"
      >
        <div className="relative aspect-[460/215] w-full shrink-0 bg-brand-2/10">
          {game.headerImage ? (
            <img
              src={game.headerImage}
              alt={game.name}
              onError={(event) => {
                const image = event.currentTarget;
                if (image.dataset.fallbackApplied) return;
                image.dataset.fallbackApplied = "true";
                image.src = `/api/game-placeholder?name=${encodeURIComponent(game.name)}`;
              }}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="bg-brand-gradient flex h-full items-center justify-center px-8 text-center text-xl font-bold text-white">
              {game.name}
            </div>
          )}
          <button
            onClick={onClose}
            aria-label="关闭详情"
            title="关闭"
            className="absolute right-3 top-3 rounded-full bg-ink/60 p-1.5 text-white transition hover:bg-ink/80"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-5 p-5 sm:p-6">
          <div>
            <h2 id="game-detail-title" className="text-xl font-bold">{game.name}</h2>
            <p className="mt-2 flex items-start gap-1.5 rounded-md bg-brand/8 px-3 py-2.5 text-sm leading-relaxed text-ink/80">
              <Sparkles size={15} className="mt-0.5 shrink-0 text-brand" />
              {game.reason}
            </p>
          </div>

          <p className="text-sm leading-relaxed text-ink/70">{game.shortDescription || "暂无简介"}</p>

          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Meta icon={Tags} label="类型" value={game.genres.join(" / ") || "未知"} />
            <Meta icon={Users} label="游玩方式" value={game.playerModes.join("、") || "未知"} />
            <Meta icon={MonitorSmartphone} label="平台" value={game.platformNames.join(" / ") || "未知"} />
            <Meta icon={Calendar} label="发售日期" value={game.releaseDate} />
            <Meta icon={Building2} label="开发商" value={game.developers.join("、") || "未知"} />
            <Meta icon={Building2} label="发行商" value={game.publishers.join("、") || "未知"} />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {game.tags.map((tag) => (
              <span key={tag} className="rounded bg-paper px-2 py-0.5 text-xs text-ink/60 ring-1 ring-ink/8">
                {tag}
              </span>
            ))}
          </div>

          {game.webSources && game.webSources.length > 0 && (
            <div className="rounded-lg border border-ink/10 bg-paper/50 px-4 py-3">
              <p className="mb-2 text-xs font-semibold text-ink/55">联网参考来源</p>
              <div className="flex flex-col gap-1.5">
                {game.webSources.slice(0, 3).map((source) => (
                  <a
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-sm text-brand-2-strong hover:underline"
                  >
                    <ExternalLink size={13} className="shrink-0" />
                    <span className="truncate">{source.title || source.domain}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="mt-1 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink/10 bg-paper/60 px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <p className="text-xs text-ink/45">价格</p>
                <p className="flex items-center gap-1.5 text-base font-bold">
                  {game.price.formatted}
                  {game.price.discountPercent > 0 && (
                    <span className="rounded bg-brand px-1.5 py-0.5 text-xs font-bold text-white">
                      -{game.price.discountPercent}%
                    </span>
                  )}
                </p>
              </div>
              {game.review && (
                <div>
                  <p className="text-xs text-ink/45">玩家评分</p>
                  <p className="flex items-center gap-1 text-sm font-semibold text-brand-2-strong">
                    <ThumbsUp size={14} />
                    {game.review.source === "steam"
                      ? `${game.review.label} · 好评率 ${game.review.positiveRate}%`
                      : game.review.label}
                  </p>
                </div>
              )}
              {game.metacritic !== null && (
                <div>
                  <p className="text-xs text-ink/45">媒体评分</p>
                  <p className="text-sm font-semibold">{game.metacritic}</p>
                </div>
              )}
            </div>
            <a
              href={game.storeUrl}
              target="_blank"
              rel="noreferrer"
              className="bg-brand-gradient flex items-center gap-1.5 rounded-md px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-105 active:scale-95"
            >
              {game.storeName}
              <ExternalLink size={15} />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function Meta({ icon: Icon, label, value }: { icon: typeof Tags; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon size={15} className="mt-0.5 shrink-0 text-brand-2-strong" />
      <div className="min-w-0">
        <p className="text-xs text-ink/45">{label}</p>
        <p className="break-words leading-snug">{value}</p>
      </div>
    </div>
  );
}
