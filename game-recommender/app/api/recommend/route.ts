import { NextRequest, NextResponse } from "next/server";
import { recommend } from "@/lib/recommend";
import { normalizeReleaseFilter } from "@/lib/recommend-preferences";
import type { AgentTraceEvent, ChatMessage, Platform, PreviousRecommendation, ReleaseFilter } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return (message.role === "user" || message.role === "assistant") && typeof message.content === "string";
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("未配置 AI_BASE_URL") || message.includes("未配置 AI")) return "服务端尚未配置 AI 接口";
  if (message.includes("游戏库") || message.includes("候选") || message.includes("换个说法") || message.includes("没有检索到支持") || message.includes("主机游戏数据源")) return message;
  if (message.includes("AI 未能")) return message;
  if (message.includes("AI 接口") || message.includes("AI 返回") || message.includes("AI 输出")) {
    return "AI 服务暂时不可用，请稍后重试";
  }
  return "推荐生成失败，请稍后重试";
}

export async function POST(request: NextRequest) {
  let body: { messages?: unknown; excludeIds?: unknown; excludeKeys?: unknown; platforms?: unknown; count?: unknown; previousGames?: unknown; releaseFilter?: unknown; favoriteGames?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0 || !body.messages.every(isChatMessage)) {
    return NextResponse.json({ error: "缺少有效的对话内容" }, { status: 400 });
  }

  const messages = body.messages
    .slice(-20)
    .map((message) => ({ ...message, content: message.content.trim().slice(0, 2000) }))
    .filter((message) => message.content.length > 0);
  if (messages.length === 0 || !messages.some((message) => message.role === "user")) {
    return NextResponse.json({ error: "对话中缺少用户需求" }, { status: 400 });
  }

  const platforms: Platform[] = (
    Array.isArray(body.platforms)
      ? body.platforms.filter((v): v is Platform => v === "steam" || v === "psn" || v === "ns" || v === "mobile")
      : []
  );

  const releaseFilter: ReleaseFilter = normalizeReleaseFilter(body.releaseFilter);

  const excludeIds = Array.isArray(body.excludeIds)
    ? body.excludeIds.filter((value): value is number => Number.isInteger(value) && value > 0).slice(-200)
    : [];

  const excludeKeys = Array.isArray(body.excludeKeys)
    ? body.excludeKeys.filter((value): value is string => typeof value === "string" && /^(gamebrain|wikidata|steam|web):\d+$/.test(value)).slice(-200)
    : [];

  const favoriteGames = Array.isArray(body.favoriteGames)
    ? body.favoriteGames.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim().slice(0, 160)).slice(0, 8)
    : [];

  const previousGames: PreviousRecommendation[] = Array.isArray(body.previousGames)
    ? body.previousGames.slice(0, 40).flatMap((value): PreviousRecommendation[] => {
        if (!value || typeof value !== "object") return [];
        const game = value as Partial<PreviousRecommendation>;
        if (typeof game.id !== "number" || !Number.isInteger(game.id) || game.id <= 0 || typeof game.name !== "string") return [];
        return [{
          id: game.id,
          name: game.name.slice(0, 160),
          platformNames: Array.isArray(game.platformNames) ? game.platformNames.filter((item): item is string => typeof item === "string").slice(0, 12) : [],
          genres: Array.isArray(game.genres) ? game.genres.filter((item): item is string => typeof item === "string").slice(0, 12) : [],
          tags: Array.isArray(game.tags) ? game.tags.filter((item): item is string => typeof item === "string").slice(0, 12) : [],
          playerModes: Array.isArray(game.playerModes) ? game.playerModes.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
          reason: typeof game.reason === "string" ? game.reason.slice(0, 240) : "",
        }];
      })
    : [];

  const count = typeof body.count === "number" && [6,10,15,20].includes(body.count) ? body.count : 6;
  const streamRequested = request.headers.get("accept")?.includes("text/event-stream") || request.nextUrl.searchParams.get("stream") === "1";

  if (!streamRequested) {
    try {
      const result = await recommend(messages, excludeIds, platforms, count, previousGames, releaseFilter, favoriteGames, excludeKeys);
      return NextResponse.json(result);
    } catch (error) {
      console.error("[recommend]", error);
      return NextResponse.json({ error: publicError(error) }, { status: 500 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const emit = (event: Omit<AgentTraceEvent, "id" | "timestamp">) => {
        send("progress", { ...event, id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, timestamp: Date.now() });
      };
      void (async () => {
        try {
          emit({ stage: "intent", title: "Request accepted", detail: "Starting the recommendation agent." });
          const result = await recommend(messages, excludeIds, platforms, count, previousGames, releaseFilter, favoriteGames, excludeKeys, emit);
          send("result", result);
        } catch (error) {
          console.error("[recommend]", error);
          send("error", { error: publicError(error) });
        } finally {
          controller.close();
        }
      })();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
