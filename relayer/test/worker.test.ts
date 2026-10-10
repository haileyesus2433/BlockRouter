import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createApp } from "../src/app";
import { hashKey } from "../src/auth";
import type { SessionState } from "../src/chain/types";
import { Ledger } from "../src/ledger";
import { charge } from "../src/pricing";
import { Store } from "../src/store";
import { fitToReservation, SettlementWorker } from "../src/worker";
import { fakeChain, issueKey, model, NOW_SECS, openSession, randomAddress, testConfig, testDeps } from "./helpers";

function setup(configOverrides = {}, store?: Store) {
  const chain = fakeChain();
  const deps = testDeps({ chain, config: testConfig(configOverrides), ...(store ? { store } : {}) });
  const worker = new SettlementWorker(deps);
  return { chain, deps, worker, app: createApp(deps) };
}

// 1_000_000 prompt tokens at 270_000 per million = 270_000 base units.
const PROMPT_FOR_270K = 1_000_000;

test("does nothing below the threshold and far from expiry", async () => {
  const { chain, deps, worker } = setup();
  const session = openSession(chain, randomAddress(), { reservedAmount: 1_000_000n });
  deps.store.addUsage(session.address, PROMPT_FOR_270K, 0, 0, NOW_SECS);
  assert.equal((await worker.tick()).get(session.address)?.status, "skipped");
  assert.equal(chain.settlements.length, 0);
});

test("settles raw token counts once pending usage reaches the threshold", async () => {
  const { chain, deps, worker } = setup({ settleThresholdBps: 2_500 });
  const session = openSession(chain, randomAddress(), { reservedAmount: 1_000_000n });
  deps.store.addUsage(session.address, PROMPT_FOR_270K, 10, 0, NOW_SECS);

  const outcome = (await worker.tick()).get(session.address);
  assert.equal(outcome?.status, "settled");
  assert.deepEqual(chain.settlements[0], { session, promptTokens: 1_000_000n, completionTokens: 10n });
  const usage = deps.store.getUsage(session.address)!;
  assert.equal(usage.settleSignature, "sig-1");
  assert.notEqual(usage.settledAt, null);
  assert.equal((await worker.tick()).size, 0, "settled sessions are not retried");
});

test("settles before expiry even below the threshold", async () => {
  const { chain, deps, worker } = setup({ settleBeforeExpirySecs: 600 });
  const session = openSession(chain, randomAddress(), { expiresAt: chain.clock.now + 600n });
  deps.store.addUsage(session.address, 10, 10, 0, NOW_SECS);
  assert.equal((await worker.tick()).get(session.address)?.status, "settled");
});

test("a close request settles, even with zero usage, and kills the key", async () => {
  const { chain, deps, worker, app } = setup();
  const session = openSession(chain, randomAddress());
  const key = issueKey(deps, session);
  const close = await app.request("/v1/session/close", { method: "POST", headers: { Authorization: `Bearer ${key}` } });
  assert.equal(close.status, 202);

  assert.equal((await worker.tick()).get(session.address)?.status, "settled");
  assert.deepEqual(chain.settlements[0], { session, promptTokens: 0n, completionTokens: 0n });
  const after = await app.request("/v1/session/current", { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(after.status, 402);
  assert.equal(((await after.json()) as any).error.code, "session_expired");
});

test("interval settling is opt-in", async () => {
  const off = setup();
  const offSession = openSession(off.chain, randomAddress());
  off.deps.store.addUsage(offSession.address, 10, 10, 0, NOW_SECS - 10_000);
  assert.equal((await off.worker.tick()).get(offSession.address)?.status, "skipped");

  const on = setup({ settleIntervalSecs: 300 });
  const onSession = openSession(on.chain, randomAddress());
  on.deps.store.addUsage(onSession.address, 10, 10, 0, NOW_SECS - 300);
  assert.equal((await on.worker.tick()).get(onSession.address)?.status, "settled");
});

test("waits for in-flight requests and blocks new ones while settling", async () => {
  const { chain, deps, worker, app } = setup({ settleThresholdBps: 1 });
  const session = openSession(chain, randomAddress());
  const key = issueKey(deps, session);
  deps.store.addUsage(session.address, PROMPT_FOR_270K, 0, 0, NOW_SECS);
  deps.ledger.hold(session.address, 5n);

  assert.equal((await worker.tick()).get(session.address)?.status, "waiting");
  assert.equal(chain.settlements.length, 0);
  const blocked = await app.request("/v1/session/current", { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(((await blocked.json()) as any).error.code, "session_expired");

  // The in-flight request finishes and records its usage before settlement runs.
  deps.store.addUsage(session.address, 0, 7, 0, NOW_SECS);
  deps.ledger.release(session.address, 5n);
  assert.equal((await worker.tick()).get(session.address)?.status, "settled");
  assert.equal(chain.settlements[0].completionTokens, 7n);
});

test("records unbillable usage when the session is gone or expired, without retrying", async () => {
  const { chain, deps, worker } = setup();
  const gone = openSession(chain, randomAddress());
  deps.store.addUsage(gone.address, 10, 10, 0, NOW_SECS);
  chain.sessions.delete(gone.address);

  const expired = openSession(chain, randomAddress(), { expiresAt: chain.clock.now - 1n });
  deps.store.addUsage(expired.address, 10, 10, 0, NOW_SECS);

  const outcomes = await worker.tick();
  assert.equal(outcomes.get(gone.address)?.status, "unbillable");
  assert.equal(outcomes.get(expired.address)?.status, "unbillable");
  assert.match(deps.store.getUsage(expired.address)!.lastError ?? "", /expired/);
  assert.equal((await worker.tick()).size, 0);
  assert.equal(chain.settlements.length, 0);
});

test("a failed settlement is recorded, unblocks the session, and is retried", async () => {
  const { chain, deps, worker } = setup({ settleThresholdBps: 1 });
  const session = openSession(chain, randomAddress());
  const key = issueKey(deps, session);
  deps.store.addUsage(session.address, PROMPT_FOR_270K, 0, 0, NOW_SECS);
  chain.failSettle = new Error("blockhash not found");

  assert.equal((await worker.tick()).get(session.address)?.status, "failed");
  assert.equal(deps.store.getUsage(session.address)!.lastError, "blockhash not found");
  await deps.ledger.resolve(deps.store.findKeyByHash(hashKey(key))!);

  chain.failSettle = null;
  assert.equal((await worker.tick()).get(session.address)?.status, "settled");
});

test("usage survives a relayer restart and is settled by the next process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relayer-"));
  try {
    const path = join(dir, "relayer.db");
    const first = setup({ settleThresholdBps: 1 }, new Store(path));
    const session = openSession(first.chain, randomAddress());
    first.deps.store.addUsage(session.address, PROMPT_FOR_270K, 3, 0, NOW_SECS);
    first.deps.store.close();

    // New process: fresh store on the same file, same chain state.
    const store = new Store(path);
    const deps = testDeps({ chain: first.chain, config: testConfig({ settleThresholdBps: 1 }), store });
    const worker = new SettlementWorker({ ...deps, ledger: new Ledger(store, first.chain, deps.config.models) });
    assert.equal((await worker.tick()).get(session.address)?.status, "settled");
    assert.equal(first.chain.settlements[0].completionTokens, 3n);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overrun usage is trimmed to the largest billable amount, never above usage", () => {
  const rates = model(1);
  const session = { reservedAmount: 1_000n } as SessionState;
  const usage = (prompt: bigint, completion: bigint) =>
    ({ promptTokens: prompt, completionTokens: completion }) as Parameters<typeof fitToReservation>[0];

  assert.deepEqual(fitToReservation(usage(100n, 100n), session, rates), { promptTokens: 100n, completionTokens: 100n });

  const fitted = fitToReservation(usage(1_000n, 10_000n), session, rates);
  assert.equal(fitted.promptTokens, 1_000n);
  assert.ok(fitted.completionTokens < 10_000n);
  const rateValues = { promptRate: rates.promptRate, completionRate: rates.completionRate };
  assert.ok(charge(fitted.promptTokens, fitted.completionTokens, rateValues) <= 1_000n);
  assert.ok(charge(fitted.promptTokens, fitted.completionTokens + 1n, rateValues) > 1_000n, "should bill the maximum that fits");

  const promptOnly = fitToReservation(usage(10_000_000n, 5n), session, rates);
  assert.equal(promptOnly.completionTokens, 0n);
  assert.ok(charge(promptOnly.promptTokens, 0n, rateValues) <= 1_000n);
});
