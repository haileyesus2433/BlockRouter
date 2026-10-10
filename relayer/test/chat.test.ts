import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import { MockProvider, type MockOptions } from "../src/providers/mock";
import { OpenAICompatibleProvider } from "../src/providers/openai";
import type { Chunk } from "../src/providers/types";
import { fakeChain, issueKey, openSession, randomAddress, testConfig, testDeps } from "./helpers";

const SECRET = "my secret prompt about project zebra";

function setup(options: { mock?: MockOptions; reserved?: bigint; rateLimit?: number } = {}) {
  const chain = fakeChain();
  const deps = testDeps({
    chain,
    config: testConfig({ rateLimitPerMinute: options.rateLimit ?? 1_000 }),
    provider: new MockProvider(options.mock ?? { reply: "one two three four five" }),
  });
  const session = openSession(chain, randomAddress(), { reservedAmount: options.reserved ?? 5_000_000n });
  const key = issueKey(deps, session);
  return { app: createApp(deps), deps, chain, session, key };
}

function chat(app: ReturnType<typeof createApp>, key: string, body: Record<string, unknown>) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v3", messages: [{ role: "user", content: SECRET }], ...body }),
  });
}

async function code(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

function sseEvents(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
}

test("non-streaming completion returns the OpenAI shape and records provider usage", async () => {
  const { app, deps, session, key } = setup();
  const response = await chat(app, key, {});
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "deepseek-v3");
  assert.equal(body.choices[0].message.content, "one two three four five");
  assert.equal(body.choices[0].finish_reason, "stop");
  // 4 + ceil(36 / 4) = 13 prompt tokens, 5 completion tokens
  assert.deepEqual(body.usage, { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 });

  const usage = deps.store.getUsage(session.address)!;
  assert.equal(usage.promptTokens, 13n);
  assert.equal(usage.completionTokens, 5n);
  assert.equal(usage.requests, 1);
  // floor((13 * 270_000 + 5 * 1_100_000) / 1e6) = 9
  assert.equal(response.headers.get("X-BlockRouter-Charge"), "9");
  assert.equal(response.headers.get("X-BlockRouter-Remaining"), String(5_000_000 - 9));
  assert.equal(response.headers.get("X-BlockRouter-Session"), session.address);
  assert.equal(response.headers.get("X-BlockRouter-Session-Expires"), String(session.expiresAt));
  assert.equal(deps.ledger.held(session.address), 0n);
});

test("charges are computed on running totals, matching what settlement will charge", async () => {
  const { app, deps, session, key } = setup();
  const charges = [];
  for (let i = 0; i < 3; i += 1) charges.push(Number((await chat(app, key, {})).headers.get("X-BlockRouter-Charge")));
  const usage = deps.store.getUsage(session.address)!;
  const total = (usage.promptTokens * 270_000n + usage.completionTokens * 1_100_000n) / 1_000_000n;
  assert.equal(BigInt(charges.reduce((a, b) => a + b, 0)), total);
});

test("rejects models the session is not bound to", async () => {
  const { app, key } = setup();
  const other = await chat(app, key, { model: "llama-3.3-70b" });
  assert.equal(other.status, 403);
  assert.equal(await code(other), "model_not_allowed");
  const unknown = await chat(app, key, { model: "gpt-9" });
  assert.equal(unknown.status, 404);
  assert.equal(await code(unknown), "model_not_found");
});

test("validates the request body", async () => {
  const { app, key } = setup();
  assert.equal((await chat(app, key, { messages: [] })).status, 400);
  assert.equal((await chat(app, key, { messages: [{ role: "robot", content: "x" }] })).status, 400);
  assert.equal((await chat(app, key, { max_tokens: 0 })).status, 400);
  const parts = await chat(app, key, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  assert.equal(parts.status, 200);
});

test("clamps max_tokens to what the session can still afford", async () => {
  // padded prompt 17 tokens costs 4.59; each completion token costs 1.1, so 4 fit in a cap of 9.
  const { app, deps, session, key } = setup({ reserved: 9n, mock: { reply: "a b c d e f g h i j" } });
  const response = await chat(app, key, { max_tokens: 100 });
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.usage.completion_tokens, 4);
  assert.equal(body.choices[0].finish_reason, "length");
  const usage = deps.store.getUsage(session.address)!;
  const pending = (usage.promptTokens * 270_000n + usage.completionTokens * 1_100_000n) / 1_000_000n;
  assert.ok(pending <= session.reservedAmount, "pending usage must never exceed the reservation");
});

test("returns 402 when nothing more fits in the cap", async () => {
  const { app, key } = setup({ reserved: 4n });
  const response = await chat(app, key, {});
  assert.equal(response.status, 402);
  assert.equal(await code(response), "session_cap_exhausted");
});

test("in-flight holds stop concurrent requests from overspending the cap", async () => {
  const { app, deps, session, key } = setup();
  deps.ledger.hold(session.address, session.reservedAmount);
  assert.equal(await code(await chat(app, key, {})), "session_cap_exhausted");
  deps.ledger.release(session.address, session.reservedAmount);
  assert.equal((await chat(app, key, {})).status, 200);
});

test("upstream failure returns 502, records nothing, and releases the hold", async () => {
  const { app, deps, session, key } = setup({ mock: { reply: "a b c", failAfter: 1 } });
  const response = await chat(app, key, {});
  assert.equal(response.status, 502);
  assert.equal(await code(response), "upstream_error");
  assert.equal(deps.store.getUsage(session.address), null);
  assert.equal(deps.ledger.held(session.address), 0n);
});

test("streams OpenAI chunks over SSE with a usage chunk when requested", async () => {
  const { app, deps, session, key } = setup();
  const response = await chat(app, key, { stream: true, stream_options: { include_usage: true } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /text\/event-stream/);
  assert.ok(Number(response.headers.get("X-BlockRouter-Charge")) > 0);
  const events = sseEvents(await response.text());
  assert.equal(events.at(-1), "[DONE]");
  const frames = events.slice(0, -1).map((event) => JSON.parse(event));
  assert.deepEqual(frames[0].choices[0].delta, { role: "assistant" });
  const text = frames.map((frame) => frame.choices[0]?.delta?.content ?? "").join("");
  assert.equal(text, "one two three four five");
  const usageFrame = frames.at(-1);
  assert.deepEqual(usageFrame.choices, []);
  assert.equal(usageFrame.usage.completion_tokens, 5);
  assert.equal(usageFrame.blockrouter.charge, 9);
  assert.equal(frames.at(-2).choices[0].finish_reason, "stop");
  assert.equal(deps.store.getUsage(session.address)?.completionTokens, 5n);
  assert.equal(deps.ledger.held(session.address), 0n);
});

test("streaming upstream failure sends an error event and records nothing", async () => {
  const { app, deps, session, key } = setup({ mock: { reply: "a b c", failAfter: 1 } });
  const events = sseEvents(await (await chat(app, key, { stream: true })).text());
  assert.equal(events.at(-1), "[DONE]");
  assert.equal(JSON.parse(events.at(-2)!).error.code, "upstream_error");
  assert.equal(deps.store.getUsage(session.address), null);
});

test("rate limits per key", async () => {
  const { app, key } = setup({ rateLimit: 2 });
  assert.equal((await chat(app, key, {})).status, 200);
  assert.equal((await chat(app, key, {})).status, 200);
  const limited = await chat(app, key, {});
  assert.equal(limited.status, 429);
  assert.equal(await code(limited), "rate_limit_exceeded");
});

test("logs token counts and divergence but never prompt or completion content", async () => {
  const { app, key } = setup({ mock: { reply: "zebra stripes", reportedPromptTokens: 20 } });
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await chat(app, key, {});
  } finally {
    console.log = original;
  }
  const log = lines.join("\n");
  assert.ok(!log.includes("zebra"), "content leaked into logs");
  const entry = JSON.parse(lines.find((line) => line.includes('"event":"usage"'))!);
  assert.equal(entry.prompt_tokens, 20);
  assert.equal(entry.estimated_prompt_tokens, 13);
  assert.equal(entry.prompt_divergence, 7);
});

test("OpenAI-compatible provider parses streamed deltas and usage", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}',
    "data: [DONE]",
    "",
  ].join("\n");
  let sent: any;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(sse, { status: 200 });
  }) as unknown as typeof fetch;
  const provider = new OpenAICompatibleProvider({ baseUrl: "https://up.example/v1/", apiKey: "k" }, fetchImpl);
  const chunks: Chunk[] = [];
  for await (const chunk of provider.chat({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], maxTokens: 50 })) {
    chunks.push(chunk);
  }
  assert.equal(sent.model, "deepseek-chat");
  assert.equal(sent.max_tokens, 50);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.deepEqual(chunks, [
    { type: "delta", content: "Hel" },
    { type: "delta", content: "lo" },
    { type: "usage", usage: { promptTokens: 11, completionTokens: 2 } },
  ]);
});

test("OpenAI-compatible provider errors on a failed upstream without echoing the body", async () => {
  const fetchImpl = (async () => new Response(`echo: ${SECRET}`, { status: 500 })) as unknown as typeof fetch;
  const provider = new OpenAICompatibleProvider({ baseUrl: "https://up.example/v1", apiKey: "k" }, fetchImpl);
  const run = async () => {
    for await (const _ of provider.chat({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 1 })) {
      // drain
    }
  };
  await assert.rejects(run, (error: Error) => error.message === "upstream returned 500");
});
