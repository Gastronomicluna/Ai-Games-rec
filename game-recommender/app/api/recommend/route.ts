import { NextRequest, NextResponse } from "next/server";
import { recommend } from "@/lib/recommend";
import type { ChatMessage, Platform } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return (message.role === "user" || message.role === "assistant") && typeof message.content === "string";
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("未配置 AI_BASE_URL") || message.includes("未配置 AI")) return "服务端尚未配置 AI 接口";
  if (message.includes("游戏库") || message.includes("候选") || message.includes("换个说法")) return message;
  if (message.includes("AI 未能")) return message;
  if (message.includes("AI 接口") || message.includes("AI 返回") || message.includes("AI 输出")) {
    return "AI 服务暂时不可用，请稍后重试";
  }
  return "推荐生成失败，请稍后重试";
}

export async function POST(request: NextRequest) {
  let body: { messages?: unknown; excludeIds?: unknown; platforms?: unknown; count?: unknown };
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
      ? body.platforms.filter((v): v is Platform => v === "steam" || v === "psn" || v === "ns")
      : []
  );

  const excludeIds = Array.isArray(body.excludeIds)
    ? body.excludeIds.filter((value): value is number => Number.isInteger(value) && value > 0).slice(-200)
    : [];

  try {
    const count = typeof body.count === "number" && [6,10,15,20].includes(body.count) ? body.count : 6;
  const result = await recommend(messages, excludeIds, platforms, count);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[recommend]", error);
    return NextResponse.json({ error: publicError(error) }, { status: 500 });
  }
}
