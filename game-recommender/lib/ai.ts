// OpenAI-compatible relay client with retries for transient and empty model responses.

interface RelayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface AiUsageStats {
  requests: number;
  retries: number;
  failures: number;
  jsonRetries: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

const usageStats: AiUsageStats = {
  requests: 0,
  retries: 0,
  failures: 0,
  jsonRetries: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
};

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordUsage(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const usage = (data as { usage?: Record<string, unknown> }).usage;
  if (!usage) return;
  const promptTokens = numeric(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = numeric(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = numeric(usage.total_tokens) || promptTokens + completionTokens;
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details;
  const cachedTokens = details && typeof details === "object"
    ? numeric((details as Record<string, unknown>).cached_tokens ?? (details as Record<string, unknown>).cache_read_input_tokens)
    : 0;
  usageStats.promptTokens += promptTokens;
  usageStats.completionTokens += completionTokens;
  usageStats.totalTokens += totalTokens;
  usageStats.cachedTokens += cachedTokens;
}

export function aiUsageStats(): AiUsageStats {
  return { ...usageStats };
}

export function diffAiUsage(before: AiUsageStats, after = aiUsageStats()): AiUsageStats {
  return {
    requests: after.requests - before.requests,
    retries: after.retries - before.retries,
    failures: after.failures - before.failures,
    jsonRetries: after.jsonRetries - before.jsonRetries,
    promptTokens: after.promptTokens - before.promptTokens,
    completionTokens: after.completionTokens - before.completionTokens,
    totalTokens: after.totalTokens - before.totalTokens,
    cachedTokens: after.cachedTokens - before.cachedTokens,
  };
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chatCompletion(messages: RelayMessage[], opts: ChatOptions = {}): Promise<string> {
  const baseUrl = process.env.AI_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.AI_API_KEY;
  const model = opts.model ?? process.env.AI_MODEL ?? "deepseek-v4-flash";
  if (!baseUrl || !apiKey) throw new Error("服务端未配置 AI_BASE_URL / AI_API_KEY");

  let maxTokens = opts.maxTokens ?? 4000;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) usageStats.retries += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      usageStats.requests += 1;
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: attempt === 0 ? opts.temperature ?? 0.6 : Math.min(opts.temperature ?? 0.6, 0.25),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        usageStats.failures += 1;
        const text = await response.text().catch(() => "");
        const error = new Error(`AI 接口错误 ${response.status}: ${text.slice(0, 200)}`);
        if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt === 0) {
          lastError = error;
          await sleep(800);
          continue;
        }
        throw error;
      }

      const data = await response.json();
      recordUsage(data);
      const content = messageText(data?.choices?.[0]?.message?.content);
      if (content) return content;

      const finishReason: string | undefined = data?.choices?.[0]?.finish_reason;
      lastError = new Error(`AI 返回了空内容${finishReason ? `（finish_reason=${finishReason}）` : ""}`);
      if (attempt === 0) {
        maxTokens = Math.max(maxTokens + 800, Math.ceil(maxTokens * 1.6));
        await sleep(400);
        continue;
      }
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error && error.message.startsWith("AI ????"))) usageStats.failures += 1;
      if (attempt === 0 && (!(error instanceof Error) || error.name === "AbortError" || /fetch|network|timeout/i.test(error.message))) {
        await sleep(800);
        continue;
      }
      if (error instanceof Error && error.message.startsWith("AI 接口错误")) throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  console.error("[chatCompletion] exhausted retries", lastError);
  throw new Error("AI 返回了空内容，请稍后重试");
}

export async function chatCompletionJson<T>(messages: RelayMessage[], opts: ChatOptions = {}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await chatCompletion(messages, {
      ...opts,
      maxTokens: attempt === 0 ? opts.maxTokens : Math.max((opts.maxTokens ?? 4000) + 800, Math.ceil((opts.maxTokens ?? 4000) * 1.5)),
      temperature: attempt === 0 ? opts.temperature : Math.min(opts.temperature ?? 0.6, 0.2),
    });
    try {
      return extractJson<T>(output);
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        usageStats.jsonRetries += 1;
        continue;
      }
    }
  }
  console.error("[chatCompletionJson] invalid JSON after retry", lastError);
  throw new Error("AI 输出格式异常，无法解析");
}

// Extract a JSON object from plain text or a fenced JSON block.
export function extractJson<T>(text: string): T {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = fence ? fence[1] : start >= 0 && end > start ? text.slice(start, end + 1) : text;
  try {
    return JSON.parse(candidate.trim()) as T;
  } catch {
    throw new Error("AI 输出格式异常，无法解析");
  }
}
