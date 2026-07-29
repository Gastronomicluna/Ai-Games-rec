"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";

interface SearchResult {
  steamId: number;
  name: string;
}

export default function GameSearchInput({
  chips,
  onChipsChange,
}: {
  chips: string[];
  onChipsChange: (chips: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const search = useCallback(async (term: string) => {
    if (term.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(`/api/search-games?q=${encodeURIComponent(term.trim())}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("search failed");
      const data = await res.json();
      if (!controller.signal.aborted) {
        setResults((data.results ?? []).filter((r: SearchResult) => !chips.includes(r.name)));
        setOpen(true);
        setActiveIdx(0);
      }
    } catch {
      if (!controller.signal.aborted) setResults([]);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [chips]);

  useEffect(() => {
    const timer = setTimeout(() => search(query), 200);
    return () => clearTimeout(timer);
  }, [query, search]);

  const addChip = (name: string) => {
    if (chips.length >= 8 || chips.includes(name)) return;
    onChipsChange([...chips, name]);
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  };

  const removeChip = (name: string) => {
    onChipsChange(chips.filter((c) => c !== name));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && results[activeIdx]) {
        addChip(results[activeIdx].name);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && query === "" && chips.length > 0) {
      removeChip(chips[chips.length - 1]);
    }
  };

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-ink/10 bg-white px-3 py-2">
        <Search size={15} className="shrink-0 text-ink/35" />
        {chips.map((chip) => (
          <span
            key={chip}
            className="flex items-center gap-0.5 rounded bg-brand-2/15 px-2 py-0.5 text-xs font-medium text-brand-2-strong"
          >
            {chip}
            <button
              onClick={() => removeChip(chip)}
              aria-label={`移除${chip}`}
              className="hover:text-ink ml-0.5"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
          placeholder={chips.length === 0 ? "搜索你喜欢的游戏…" : "继续添加…"}
          className="min-w-[120px] flex-1 bg-transparent py-1 text-[15px] outline-none placeholder:text-ink/35"
        />
        {loading && <Loader2 size={14} className="shrink-0 animate-spin text-ink/35" />}
      </div>

      {open && results.length > 0 && (
        <ul
          ref={listRef}
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-ink/10 bg-white shadow-lg"
        >
          {results.map((r, i) => (
            <li key={r.steamId}>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  addChip(r.name);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
                  i === activeIdx ? "bg-brand-2/10 text-brand-2-strong" : "text-ink/80 hover:bg-ink/5"
                }`}
              >
                <span className="truncate">{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && query.trim().length >= 2 && !loading && results.length === 0 && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-ink/10 bg-white px-4 py-3 text-sm text-ink/45 shadow-lg">
          未找到匹配的游戏
        </div>
      )}
    </div>
  );
}
