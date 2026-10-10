import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { MockProvider } from "../src/mock-provider.js";
import type { ChatChunk, ChatRequest, Provider } from "../src/provider.js";

const provider: Provider = new MockProvider();

async function collect(req: ChatRequest): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of provider.chat(req)) chunks.push(chunk);
  return chunks;
}

test("mock identity and outputs are stable through the Provider interface", async () => {
  assert.equal(provider.id, "mock");
  assert.equal(new MockProvider().id, provider.id);
  const req: ChatRequest = {
    model: "test-model",
    messages: [{ role: "user", content: "hello world" }],
  };
  assert.equal(provider.countTokens(req), 2);
  assert.equal(new MockProvider().countTokens(req), 2);
  const expected: ChatChunk[] = [
    { type: "text", delta: "hello world" },
    {
      type: "done",
      finishReason: "stop",
      usage: { promptTokens: 2, completionTokens: 2 },
    },
  ];
  assert.deepEqual(await collect(req), expected);
  assert.deepEqual(await collect(req), expected);
  assert.deepEqual(req.messages, [{ role: "user", content: "hello world" }]);
});

test("empty, multiple and unusual messages follow the documented counting rule", async () => {
  const cases: { contents: string[]; tokens: number }[] = [
    { contents: [], tokens: 0 },
    { contents: [""], tokens: 0 },
    { contents: [" \t\n"], tokens: 0 },
    { contents: ["", ""], tokens: 0 },
    { contents: ["one two", "three", ""], tokens: 3 },
    { contents: ["a", "b"], tokens: 2 },
    { contents: ["你好 👋", "x\ty\nz", "a\u00a0b"], tokens: 7 },
    { contents: ["punctuation,!", "a\u0000b"], tokens: 2 },
  ];
  for (const { contents, tokens } of cases) {
    const req: ChatRequest = {
      model: "arbitrary-model",
      messages: contents.map((content, i) => ({
        role: i % 2 ? "assistant" : "user",
        content,
      })),
    };
    const response = contents.join("\n");
    assert.equal(provider.countTokens(req), tokens);
    assert.ok(Number.isInteger(provider.countTokens(req)) && tokens >= 0);
    const chunks = await collect(req);
    assert.deepEqual(chunks, [
      ...(response.length ? [{ type: "text", delta: response }] : []),
      {
        type: "done",
        finishReason: "stop",
        usage: { promptTokens: tokens, completionTokens: tokens },
      },
    ]);
  }
});

test("stream snapshots request state before its first text chunk", async () => {
  const req: ChatRequest = {
    model: "mock",
    messages: [{ role: "user", content: "original text" }],
  };
  const iterator = provider.chat(req)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text", delta: "original text" },
  });
  req.messages[0].content = "changed";
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      type: "done",
      finishReason: "stop",
      usage: { promptTokens: 2, completionTokens: 2 },
    },
  });
  assert.equal((await iterator.next()).done, true);
});

test("mock import and iteration need no network or environment credentials", () => {
  const moduleUrl = new URL("../src/mock-provider.js", import.meta.url).href;
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    const forbidden = () => { throw new Error('Network access forbidden'); };
    globalThis.fetch = forbidden;
    http.request = http.get = https.request = https.get = forbidden;
    net.Socket.prototype.connect = forbidden;
    const { MockProvider } = await import(${JSON.stringify(moduleUrl)});
    const mock = new MockProvider();
    const req = { model: 'mock', messages: [{ role: 'user', content: 'offline' }] };
    assert.equal(mock.countTokens(req), 1);
    const chunks = [];
    for await (const chunk of mock.chat(req)) chunks.push(chunk);
    assert.deepEqual(chunks, [
      { type: 'text', delta: 'offline' },
      { type: 'done', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } },
    ]);
  `,
    ],
    { env: {}, encoding: "utf8" },
  );
  assert.equal(result, "");
});
