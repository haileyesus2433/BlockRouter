import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import { countPromptTokens, MockProvider } from "../src/providers/mock";
import { OpenAICompatibleProvider } from "../src/providers/openai";
import type { Provider } from "../src/providers/types";
import { fakeChain, issueKey, openSession, randomAddress, testDeps } from "./helpers";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];
const ARGS = '{"path":"src/lib.rs"}';

function setup(provider: Provider = new MockProvider({ toolCall: { name: "read_file", arguments: ARGS } })) {
  const chain = fakeChain();
  const deps = testDeps({ chain, provider });
  const session = openSession(chain, randomAddress());
  return { app: createApp(deps), deps, session, key: issueKey(deps, session) };
}

function chat(app: ReturnType<typeof createApp>, key: string, body: Record<string, unknown>) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v3", tools: TOOLS, ...body }),
  });
}

const firstTurn = [{ role: "user", content: "What is in src/lib.rs?" }];
const secondTurn = [
  ...firstTurn,
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_mock_0", type: "function", function: { name: "read_file", arguments: ARGS } }],
  },
  { role: "tool", tool_call_id: "call_mock_0", content: "pub mod vault;" },
];

function sse(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
}

test("non-streaming responses return assembled tool calls with finish_reason tool_calls", async () => {
  const { app, deps, session, key } = setup();
  const response = await chat(app, key, { messages: firstTurn });
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  const choice = body.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, null);
  assert.deepEqual(choice.message.tool_calls, [
    { id: "call_mock_0", type: "function", function: { name: "read_file", arguments: ARGS } },
  ]);
  assert.ok(deps.store.getUsage(session.address)!.completionTokens > 0n, "tool calls are billed");
});

test("streams tool calls as OpenAI deltas: id and name first, then argument pieces", async () => {
  const { app, key } = setup();
  const events = sse(await (await chat(app, key, { messages: firstTurn, stream: true })).text());
  assert.equal(events.at(-1), "[DONE]");
  const deltas = events.slice(0, -1).map((e) => JSON.parse(e).choices[0]);
  const toolDeltas = deltas.filter((c) => c.delta.tool_calls).map((c) => c.delta.tool_calls[0]);
  assert.deepEqual(toolDeltas[0], { index: 0, id: "call_mock_0", type: "function", function: { name: "read_file", arguments: "" } });
  assert.equal(toolDeltas.slice(1).every((d) => d.id === undefined && d.function.name === undefined), true);
  assert.equal(toolDeltas.map((d) => d.function.arguments).join(""), ARGS);
  assert.equal(deltas.at(-1).finish_reason, "tool_calls");
});

test("accepts the follow-up turn with assistant tool_calls and a tool result", async () => {
  const { app, key } = setup();
  const response = await chat(app, key, { messages: secondTurn });
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.choices[0].message.content, "mock reply to tool result: pub mod vault;");
});

test("rejects malformed tool messages", async () => {
  const { app, key } = setup();
  const noId = await chat(app, key, { messages: [...firstTurn, { role: "tool", content: "x" }] });
  assert.equal(noId.status, 400);
  const badCall = await chat(app, key, {
    messages: [...firstTurn, { role: "assistant", content: null, tool_calls: [{ id: "x" }] }],
  });
  assert.equal(badCall.status, 400);
  const empty = await chat(app, key, { messages: [...firstTurn, { role: "assistant", content: null }] });
  assert.equal(empty.status, 400);
  const tools = await chat(app, key, { messages: firstTurn, tools: "nope" });
  assert.equal(tools.status, 400);
});

test("tool definitions and tool-call arguments count toward the prompt estimate", () => {
  const base = { model: "m", maxTokens: 10, messages: [{ role: "user" as const, content: "hi" }] };
  const withTools = { ...base, tools: TOOLS };
  assert.ok(countPromptTokens(withTools) > countPromptTokens(base));
  const withCall = {
    ...base,
    messages: [
      ...base.messages,
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "c", type: "function" as const, function: { name: "read_file", arguments: ARGS } }],
      },
    ],
  };
  assert.ok(countPromptTokens(withCall) > countPromptTokens(base) + 4);
});

test("a full agent round trip passes tools, options, and tool messages through to the upstream", async () => {
  const sent: any[] = [];
  const replies = [
    [
      'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"src/lib.rs\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":18}}',
      "data: [DONE]",
    ],
    [
      'data: {"choices":[{"delta":{"content":"It declares the vault module."}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":150,"completion_tokens":7}}',
      "data: [DONE]",
    ],
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(`${replies[sent.length - 1]!.join("\n")}\n`, { status: 200 });
  }) as unknown as typeof fetch;
  const { app, deps, session, key } = setup(new OpenAICompatibleProvider({ baseUrl: "https://up.example/v1", apiKey: "k" }, fetchImpl));

  const first = (await (await chat(app, key, { messages: firstTurn, tool_choice: "auto", top_p: 0.9, stream: true })).text());
  const toolDeltas = sse(first)
    .slice(0, -1)
    .map((e) => JSON.parse(e).choices[0]?.delta?.tool_calls?.[0])
    .filter(Boolean);
  assert.equal(toolDeltas[0].id, "call_1");
  assert.equal(toolDeltas.map((d: any) => d.function.arguments).join(""), ARGS);

  assert.deepEqual(sent[0].tools, TOOLS);
  assert.equal(sent[0].tool_choice, "auto");
  assert.equal(sent[0].top_p, 0.9);
  assert.equal(sent[0].model, "deepseek-chat");

  const replay = [
    ...firstTurn,
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: ARGS } }] },
    { role: "tool", tool_call_id: "call_1", content: "pub mod vault;" },
  ];
  const second = (await (await chat(app, key, { messages: replay })).json()) as any;
  assert.equal(second.choices[0].message.content, "It declares the vault module.");
  assert.deepEqual(sent[1].messages[1].tool_calls[0].function, { name: "read_file", arguments: ARGS });
  assert.equal(sent[1].messages[1].content, null);
  assert.equal(sent[1].messages[2].tool_call_id, "call_1");

  const usage = deps.store.getUsage(session.address)!;
  assert.equal(usage.promptTokens, 270n);
  assert.equal(usage.completionTokens, 25n);
});
