import assert from "node:assert/strict";
import { test } from "node:test";

import { MockProvider } from "../src/providers/mock";
import type { ChatRequest, Chunk } from "../src/providers/types";

const request: ChatRequest = {
  model: "deepseek-chat",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello there friend" },
  ],
  maxTokens: 100,
};

async function collect(chunks: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const out: Chunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

test("counts prompt tokens deterministically", () => {
  const provider = new MockProvider();
  // (4 + ceil(8/4)) + (4 + ceil(18/4)) = 6 + 9
  assert.equal(provider.countTokens(request), 15);
  assert.equal(provider.countTokens(request), provider.countTokens(structuredClone(request)));
});

test("streams one token per word and reports usage last", async () => {
  const chunks = await collect(new MockProvider({ reply: "one two three" }).chat(request));
  assert.deepEqual(chunks, [
    { type: "delta", content: "one" },
    { type: "delta", content: " two" },
    { type: "delta", content: " three" },
    { type: "usage", usage: { promptTokens: 15, completionTokens: 3 } },
  ]);
});

test("respects max tokens", async () => {
  const chunks = await collect(new MockProvider({ reply: "a b c d e" }).chat({ ...request, maxTokens: 2 }));
  assert.deepEqual(chunks.at(-1), { type: "usage", usage: { promptTokens: 15, completionTokens: 2 } });
});

test("echoes the last user message by default", async () => {
  const chunks = await collect(new MockProvider().chat(request));
  const text = chunks.flatMap((c) => (c.type === "delta" ? [c.content] : [])).join("");
  assert.equal(text, "mock reply to: hello there friend");
});

test("can report divergent usage and fail mid-stream", async () => {
  const divergent = await collect(new MockProvider({ reply: "x", reportedPromptTokens: 99 }).chat(request));
  assert.deepEqual(divergent.at(-1), { type: "usage", usage: { promptTokens: 99, completionTokens: 1 } });
  await assert.rejects(collect(new MockProvider({ reply: "a b c", failAfter: 1 }).chat(request)), /mock upstream failure/);
});
