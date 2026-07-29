// OpenAI 兼容转接站调用。deepseek-v4-pro 是推理模型：
// 思考过程消耗 completion_tokens，需要给足 max_tokens，且要处理"思考完没输出正文"的情况。

interface RelayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export async function chatCompletion(messages: RelayMessage[], opts: ChatOptions = {}): Promise<string> {
  const baseUrl = process.env.AI_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.AI_API_KEY;
  const model = opts.model ?? process.env.AI_MODEL ?? "deepseek-v4-pro";
  if (!baseUrl || !apiKey) {
    throw new Error("服务端未配置 AI_BASE_URL / AI_API_KEY");
  }

  let maxTokens = opts.maxTokens ?? 4000;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: opts.temperature ?? 0.6,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI 接口错误 ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    const finishReason: string | undefined = data?.choices?.[0]?.finish_reason;
    if (content && content.trim()) return content.trim();
    // 推理模型可能把 token 全用在思考上导致正文为空，放大额度重试一次
    if (finishReason === "length" && attempt === 0) {
      maxTokens = maxTokens * 2;
      continue;
    }
    throw new Error("AI 返回了空内容，请稍后重试");
  }
  throw new Error("AI 返回了空内容，请稍后重试");
}

// 从模型输出中稳健提取 JSON 对象
export function extractJson<T>(text: string): T {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    throw new Error("AI 输出格式异常，无法解析");
  }
}

