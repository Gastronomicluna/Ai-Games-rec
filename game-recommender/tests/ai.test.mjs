import test from "node:test";
import assert from "node:assert/strict";

process.env.AI_BASE_URL = "https://relay.example";
process.env.AI_API_KEY = "fixture-key";
process.env.AI_MODEL = "fixture-model";

const ai = await import("../lib/ai.ts?retry-fixture");

test("chatCompletion retries an empty response regardless of finish reason", async () => {
  const requests = [];
  const responses = [
    { choices: [{ message: { content: "" }, finish_reason: "stop" }] },
    { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
  ];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json(responses.shift());
  };

  const result = await ai.chatCompletion([{ role: "user", content: "hello" }], { maxTokens: 100 });
  assert.equal(result, "ok");
  assert.equal(requests.length, 2);
  assert.ok(requests[1].max_tokens > requests[0].max_tokens);
});

test("chatCompletionJson retries malformed JSON output", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      choices: [{ message: { content: calls === 1 ? "not json" : '{"value":42}' }, finish_reason: "stop" }],
    });
  };

  const result = await ai.chatCompletionJson([{ role: "user", content: "return json" }], { maxTokens: 200 });
  assert.deepEqual(result, { value: 42 });
  assert.equal(calls, 2);
});


test("AI metrics record request and token usage", async () => {
  const before = ai.aiUsageStats();
  globalThis.fetch = async () => Response.json({
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } },
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  });

  assert.equal(await ai.chatCompletion([{ role: "user", content: "metrics" }], { maxTokens: 32 }), "ok");
  const delta = ai.diffAiUsage(before);
  assert.equal(delta.requests, 1);
  assert.equal(delta.promptTokens, 12);
  assert.equal(delta.completionTokens, 7);
  assert.equal(delta.totalTokens, 19);
  assert.equal(delta.cachedTokens, 3);
});
