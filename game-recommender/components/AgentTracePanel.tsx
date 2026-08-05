"use client";

import { Activity, CheckCircle2, ChevronDown, ChevronRight, Database, Loader2, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import type { AgentTraceEvent } from "@/lib/types";

const STAGE_ICON = {
  intent: Search,
  profile: Database,
  agent: Sparkles,
  tool: Activity,
  filter: Activity,
  rank: Sparkles,
  enrich: Database,
  complete: CheckCircle2,
  error: Activity,
} satisfies Record<AgentTraceEvent["stage"], typeof Activity>;

const COPY = {
  running: "\u6b63\u5728\u63a8\u8350\u4e2d",
  complete: "\u63a8\u8350\u5b8c\u6210",
  title: "Agent \u5de5\u4f5c\u65e5\u5fd7",
  detail: "\u5c55\u793a\u68c0\u7d22\u7b56\u7565\u3001\u5de5\u5177\u8c03\u7528\u548c\u5019\u9009\u7edf\u8ba1\uff0c\u4e0d\u5c55\u793a\u6a21\u578b\u539f\u59cb\u601d\u7ef4\u94fe\u3002",
  expand: "\u5c55\u5f00\u6267\u884c\u65e5\u5fd7",
  collapse: "\u6536\u8d77\u6267\u884c\u65e5\u5fd7",
};

export default function AgentTracePanel({ events, loading }: { events: AgentTraceEvent[]; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (events.length === 0 && !loading) return null;
  const status = loading ? COPY.running : COPY.complete;

  return (
    <section className="mb-5 overflow-hidden rounded-lg border border-brand-2/25 bg-brand-2/5 shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-brand-2/10"
      >
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
          {loading ? <Loader2 size={16} className="animate-spin text-brand-strong" /> : <CheckCircle2 size={16} className="text-brand-strong" />}
          {status}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-ink/55">
          {expanded ? COPY.collapse : COPY.expand}
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-brand-2/20 px-4 py-3">
          <p className="text-sm font-semibold text-ink">{COPY.title}</p>
          <p className="mt-0.5 text-xs text-ink/55">{COPY.detail}</p>
          <ol className="mt-3 space-y-2 border-l border-brand-2/25 pl-3">
            {events.slice(-12).map((event) => {
              const Icon = STAGE_ICON[event.stage];
              return (
                <li key={event.id} className="relative text-sm">
                  <span className="absolute -left-[1.08rem] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white text-brand-strong ring-1 ring-brand-2/30"><Icon size={10} /></span>
                  <p className="font-medium text-ink/80">{event.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink/60">{event.detail}</p>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
