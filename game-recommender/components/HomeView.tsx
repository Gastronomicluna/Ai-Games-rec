"use client";

import { useState } from "react";
import { ArrowRight, Database, Gamepad2, MessagesSquare, Monitor, RefreshCw, Sparkles } from "lucide-react";
import type { Platform } from "@/lib/types";
import GameSearchInput from "./GameSearchInput";
import PixelLogo from "./PixelLogo";

const EXAMPLE_PROMPTS = [
  "我想要一个双人合作的游戏",
  "给我推荐一个像原神那样的二次元游戏",
  "我想玩动作类型的3A作品，要注重战斗",
];

const FEATURES = [
  { icon: MessagesSquare, title: "对话式推荐", desc: "用大白话描述需求，边聊边改" },
  { icon: Database, title: "真实游戏数据", desc: "实时检索 RAWG 与 Steam，不编造" },
  { icon: RefreshCw, title: "列表持续迭代", desc: "补充需求、换一批，越聊越准" },
];

const PIXELS = [
  { left: "12%", top: "18%", size: 10, color: "#f88e1c", delay: "0s" },
  { left: "22%", top: "72%", size: 8, color: "#6ccee3", delay: "1.2s" },
  { left: "80%", top: "24%", size: 12, color: "#6ccee3", delay: "0.6s" },
  { left: "88%", top: "66%", size: 8, color: "#f88e1c", delay: "1.8s" },
  { left: "66%", top: "12%", size: 6, color: "#f88e1c", delay: "2.4s" },
  { left: "8%", top: "44%", size: 6, color: "#6ccee3", delay: "3s" },
];

const PLATFORM_OPTIONS: { key: Platform; label: string; icon: typeof Monitor }[] = [
  { key: "steam", label: "Steam", icon: Monitor },
  { key: "psn", label: "PSN", icon: Gamepad2 },
  { key: "ns", label: "NS", icon: Gamepad2 },
];

export default function HomeView({
  loading,
  error,
  platforms,
  onPlatformsChange,
  count,
  onCountChange,
  onSubmit,
}: {
  loading: boolean;
  error: string | null;
  platforms: Platform[];
  onPlatformsChange: (p: Platform[]) => void;
  count: number;
  onCountChange: (c: number) => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [chips, setChips] = useState<string[]>([]);

  const canSubmit = !loading && (text.trim().length > 0 || chips.length > 0);

  const togglePlatform = (p: Platform) => {
    onPlatformsChange(
      platforms.includes(p) ? platforms.filter((x: Platform) => x !== p) : [...platforms, p]
    );
  };

  const submit = () => {
    if (!canSubmit) return;
    const likePart = chips.length > 0 ? `我喜欢《${chips.join("》《")}》。` : "";
    const demand = text.trim() || "推荐一些类似的游戏";
    onSubmit(`${likePart}${demand}`);
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      {PIXELS.map((p, i) => (
        <span
          key={i}
          className="float-y pointer-events-none absolute pixelated opacity-50"
          style={{ left: p.left, top: p.top, width: p.size, height: p.size, background: p.color, animationDelay: p.delay }}
        />
      ))}

      <header className="mx-auto flex w-full max-w-6xl items-center gap-2 px-6 pt-6">
        <PixelLogo size={26} />
        <span className="text-lg font-bold tracking-wide">玩什么</span>
        <span className="rounded border border-brand-2 px-1.5 py-0.5 text-xs text-brand-2-strong">AI 游戏推荐</span>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-14">
        <PixelLogo size={56} />
        <h1 className="mt-6 text-center text-4xl font-bold leading-tight md:text-5xl">
          今晚<span className="text-brand-gradient">玩什么</span>？
          <span className="caret-blink ml-1 inline-block h-8 w-4 bg-brand align-baseline md:h-10" />
        </h1>
        <p className="mt-4 text-center text-base text-ink/60">
          告诉 AI 你现在的游戏口味，从真实游戏库里为你挑出下一款心头好
        </p>

        <div className="hard-shadow mt-8 w-full rounded-lg border border-ink/10 bg-white p-2">
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-1.5">
              {chips.map((c) => (
                <span key={c} className="flex items-center gap-1 rounded bg-brand-2/15 px-2 py-0.5 text-xs text-brand-2-strong">
                  喜欢《{c}》
                  <button onClick={() => setChips(chips.filter((x) => x !== c))} aria-label={`移除${c}`} className="hover:text-ink">
                    <Sparkles size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder="比如：我想要一个双人合作的游戏，不要太难…"
              className="max-h-32 flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] outline-none placeholder:text-ink/35"
            />
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="bg-brand-gradient m-1 flex h-11 items-center gap-1.5 rounded-md px-5 text-sm font-semibold text-white transition enabled:hover:brightness-105 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? "推荐中…" : "推荐"}
              {!loading && <ArrowRight size={16} />}
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-3 w-full rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="mt-4 w-full">
          <GameSearchInput chips={chips} onChipsChange={setChips} />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <span className="text-xs text-ink/45">平台偏好：</span>
          {PLATFORM_OPTIONS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => togglePlatform(key)}
              className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition ${
                platforms.includes(key)
                  ? "border-brand bg-brand/10 font-medium text-brand-strong"
                  : "border-ink/15 bg-white text-ink/70 hover:border-brand-2 hover:text-brand-2-strong"
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <span className="text-xs text-ink/45">每批数量：</span>
          {([6, 10, 15, 20] as const).map((n) => (
            <button
              key={n}
              onClick={() => onCountChange(n)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                count === n
                  ? "border-brand bg-brand/10 font-medium text-brand-strong"
                  : "border-ink/15 bg-white text-ink/70 hover:border-brand-2 hover:text-brand-2-strong"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
</div>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Sparkles size={13} className="text-brand" />
          {EXAMPLE_PROMPTS.map((p) => (
            <button
              key={p}
              onClick={() => setText(p)}
              className="text-xs text-ink/50 underline decoration-dotted underline-offset-4 hover:text-brand-strong"
            >
              {p}
            </button>
          ))}
        </div>

        <div className="mt-12 grid w-full grid-cols-1 gap-4 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-lg border border-ink/8 bg-white p-4">
              <f.icon size={20} className="text-brand-2-strong" />
              <p className="mt-2 text-sm font-semibold">{f.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink/55">{f.desc}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="pb-5 text-center text-xs text-ink/35">
        游戏数据来自 RAWG 与 Steam · 推荐由 AI 实时生成
      </footer>
    </div>
  );
}
