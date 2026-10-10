import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import { fakeChain, issueKey, model, NOW_SECS, openSession, randomAddress, testConfig, testDeps } from "./helpers";

function setup() {
  const chain = fakeChain();
  const config = testConfig({
    models: [...testConfig().models, { id: 3, alias: "unregistered", upstream: "x" }],
  });
  const deps = testDeps({ chain, config });
  return { chain, deps, app: createApp(deps) };
}

async function get(app: ReturnType<typeof createApp>, path: string, key?: string) {
  const response = await app.request(path, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

test("lists registered models with raw on-chain rates", async () => {
  const { app, chain } = setup();
  chain.models.set(2, model(2, { promptRate: 590_000n, completionRate: 790_000n, pendingPromptRate: 600_000n, pendingCompletionRate: 800_000n, effectiveAt: 1_800_003_600n }));
  const { status, body } = await get(app, "/v1/models");
  assert.equal(status, 200);
  assert.equal(body.object, "list");
  assert.deepEqual(body.data.map((m: { id: string }) => m.id), ["deepseek-v3", "llama-3.3-70b"]);
  assert.deepEqual(body.data[0], {
    id: "deepseek-v3",
    object: "model",
    created: 0,
    owned_by: "blockrouter",
    blockrouter: {
      model_id: 1,
      prompt_rate: 270_000,
      completion_rate: 1_100_000,
      pending_prompt_rate: 0,
      pending_completion_rate: 0,
      effective_at: 0,
      active: true,
    },
  });
  assert.equal(body.data[1].blockrouter.pending_prompt_rate, 600_000);
  assert.equal(body.data[1].blockrouter.effective_at, 1_800_003_600);
});

test("session/current requires an API key", async () => {
  const { app } = setup();
  const { status, body } = await get(app, "/v1/session/current");
  assert.equal(status, 401);
  assert.equal(body.error.code, "invalid_api_key");
});

test("session/current reports cap, pending usage, and remaining budget", async () => {
  const { app, chain, deps } = setup();
  const session = openSession(chain, randomAddress(), { reservedAmount: 1_000_000n });
  const key = issueKey(deps, session);
  deps.store.addUsage(session.address, 1_000, 500, 1_100, NOW_SECS);

  const { status, body } = await get(app, "/v1/session/current", key);
  assert.equal(status, 200);
  assert.equal(body.session, session.address);
  assert.equal(body.model, "deepseek-v3");
  assert.equal(body.cap, 1_000_000);
  // 1_000 * 270_000 / 1e6 + 500 * 1_100_000 / 1e6
  assert.equal(body.pending, 820);
  assert.equal(body.remaining, 1_000_000 - 820);
  assert.equal(body.requests, 1);
  assert.equal(body.expires_at, Number(session.expiresAt));
});

test("pending usage is priced at the higher pending rate during a timelock", async () => {
  const { app, chain, deps } = setup();
  chain.models.set(1, model(1, { pendingPromptRate: 540_000n, pendingCompletionRate: 1_100_000n, effectiveAt: chain.clock.now + 3_600n }));
  const session = openSession(chain, randomAddress());
  const key = issueKey(deps, session);
  deps.store.addUsage(session.address, 1_000_000, 0, 1_000_000, NOW_SECS);
  const { body } = await get(app, "/v1/session/current", key);
  assert.equal(body.pending, 540_000);
});

test("session/current explains closed, settled, expired, and inactive-model sessions", async () => {
  const { app, chain, deps } = setup();

  const reclaimed = openSession(chain, randomAddress());
  const reclaimedKey = issueKey(deps, reclaimed);
  chain.sessions.delete(reclaimed.address);
  assert.equal((await get(app, "/v1/session/current", reclaimedKey)).body.error.code, "no_active_session");

  const settled = openSession(chain, randomAddress());
  const settledKey = issueKey(deps, settled);
  deps.store.addUsage(settled.address, 1, 1, 1, NOW_SECS);
  deps.store.markSettled(settled.address, "sig", NOW_SECS);
  const settledResponse = await get(app, "/v1/session/current", settledKey);
  assert.equal(settledResponse.status, 402);
  assert.equal(settledResponse.body.error.code, "session_expired");

  const expired = openSession(chain, randomAddress(), { expiresAt: chain.clock.now });
  assert.equal((await get(app, "/v1/session/current", issueKey(deps, expired))).body.error.code, "session_expired");

  chain.models.set(2, model(2, { isActive: false }));
  const inactive = openSession(chain, randomAddress(), { modelId: 2 });
  const inactiveResponse = await get(app, "/v1/session/current", issueKey(deps, inactive));
  assert.equal(inactiveResponse.status, 404);
  assert.equal(inactiveResponse.body.error.code, "model_not_found");
});
