"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, RotateCcw, Send } from "lucide-react";
import type { ChatMessage } from "@/lib/types";

export default function ChatDock({
  messages,
  loading,
  onSend,
  onReset,
}: {
  messages: ChatMessage[];
  loading: boolean;
  onSend: (text: string) => boolean | Promise<boolean>;
  onReset: () => void;
}) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const visible = expanded ? messages : messages.slice(-2);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, expanded]);

  const send = async () => {
    const value = text.trim();
    if (!value || loading) return;
    const succeeded = await onSend(value);
    if (succeeded) setText("");
  };

  return (
    <div className="sticky bottom-0 z-40 mt-8 border-t border-ink/10 bg-white/92 shadow-[0_-8px_24px_-12px_rgba(22,36,46,0.25)] backdrop-blur">
      <div className="mx-auto w-full max-w-3xl px-4 py-3">
        {messages.length > 2 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mb-1.5 flex items-center gap-1 text-xs text-ink/45 hover:text-brand-strong"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            {expanded ? "收起对话记录" : `展开全部对话（${messages.length} 条）`}
          </button>
        )}

        <div ref={listRef} className={`thin-scroll flex flex-col gap-2 overflow-y-auto pr-1 ${expanded ? "max-h-56" : "max-h-28"}`}>
          {visible.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  m.role === "user" ? "bg-brand/12 text-ink" : "bg-paper text-ink/80 ring-1 ring-ink/8"
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-lg bg-paper px-3 py-2 text-sm text-ink/55 ring-1 ring-ink/8">
                <Loader2 size={14} className="animate-spin text-brand-2-strong" />
                AI 正在检索游戏库…
              </div>
            </div>
          )}
        </div>

        <div className="mt-2 flex items-end gap-2">
          <button
            onClick={onReset}
            title="新建对话（清空当前推荐与对话）"
            aria-label="新建对话"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-ink/12 text-ink/55 transition hover:border-brand hover:text-brand-strong"
          >
            <RotateCcw size={17} />
          </button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="补充需求，比如：再便宜一点、要能联机的…"
            className="max-h-28 flex-1 resize-none rounded-md border border-ink/12 bg-white px-3 py-2.5 text-[15px] outline-none transition placeholder:text-ink/35 focus:border-brand-2"
          />
          <button
            onClick={send}
            disabled={loading || !text.trim()}
            title="发送"
            aria-label="发送"
            className="bg-brand-gradient flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-white transition enabled:hover:brightness-105 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}
