import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import { MockProvider } from "../src/providers/mock";
import { SettlementWorker } from "../src/worker";
import { fakeChain, issueKey, model, openSession, randomAddress, testConfig, testDeps } from "./helpers";

function setup(allowedModels = [1, 2], configOverrides = {}) {
  const chain = fakeChain();
  const deps = testDeps({ chain, config: testConfig(configOverrides), provider: new MockProvider({ reply: "one two three" }) });
  const session = openSession(chain, randomAddress(), { allowedModels });
  return { app: createApp(deps), deps, chain, session, key: issueKey(deps, session) };
}

function chat(app: ReturnType<typeof createApp>, key: string, model: string) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello there" }] }),
  });
}

test("one session can be used with every model it allows", async () => {
  const { app, deps, session, key } = setup();
  assert.equal((await chat(app, key, "deepseek-v3")).status, 200);
  assert.equal((await chat(app, key, "llama-3.3-70b")).status, 200);
  assert.equal((await chat(app, key, "deepseek-v3")).status, 200);

  const usage = deps.store.getUsage(session.address)!;
  assert.equal(usage.requests, 3);
  assert.deepEqual(
    usage.models.map((line) => [line.modelId, line.promptTokens, line.completionTokens]),
    [
      [1, 14n, 6n],
      [2, 7n, 3n],
    ],
  );
});

test("each model is charged at its own rate", async () => {
  const { app, key } = setup();
  // 7 prompt + 3 completion tokens: deepseek (270k/1.1M) costs 5, llama (590k/790k) costs 6.
  assert.equal((await chat(app, key, "deepseek-v3")).headers.get("X-BlockRouter-Charge"), "5");
  assert.equal((await chat(app, key, "llama-3.3-70b")).headers.get("X-BlockRouter-Charge"), "6");
});

test("models outside the session's set are refused with the allowed list", async () => {
  const { app, key } = setup([1]);
  const response = await chat(app, key, "llama-3.3-70b");
  assert.equal(response.status, 403);
  const error = ((await response.json()) as any).error;
  assert.equal(error.code, "model_not_allowed");
  assert.match(error.message, /Allowed: deepseek-v3/);
});

test("session/current reports usage per model", async () => {
  const { app, key } = setup();
  await chat(app, key, "deepseek-v3");
  await chat(app, key, "llama-3.3-70b");
  const body = (await (await app.request("/v1/session/current", { headers: { Authorization: `Bearer ${key}` } })).json()) as any;
  assert.deepEqual(body.models, ["deepseek-v3", "llama-3.3-70b"]);
  assert.deepEqual(
    body.usage.map((line: any) => line.model),
    ["deepseek-v3", "llama-3.3-70b"],
  );
  assert.equal(body.pending, 5 + 6);
});

test("settlement submits one line per model in a single transaction", async () => {
  const { app, deps, chain, session, key } = setup();
  await chat(app, key, "deepseek-v3");
  await chat(app, key, "llama-3.3-70b");
  deps.store.requestClose(session.address, deps.nowSecs());
  const outcome = (await new SettlementWorker(deps).tick()).get(session.address);
  assert.equal(outcome?.status, "settled");
  assert.equal(chain.settlements.length, 1);
  assert.deepEqual(chain.settlements[0]!.lines, [
    { modelId: 1, promptTokens: 7n, completionTokens: 3n },
    { modelId: 2, promptTokens: 7n, completionTokens: 3n },
  ]);
});

test("a model deactivated mid-session is dropped so the rest still settles", async () => {
  const { app, deps, chain, session, key } = setup();
  await chat(app, key, "deepseek-v3");
  await chat(app, key, "llama-3.3-70b");
  chain.models.set(2, model(2, { isActive: false }));
  deps.store.requestClose(session.address, deps.nowSecs());
  const outcome = (await new SettlementWorker(deps).tick()).get(session.address);
  assert.equal(outcome?.status, "settled");
  assert.deepEqual(
    chain.settlements[0]!.lines.map((line) => line.modelId),
    [1],
  );
});
