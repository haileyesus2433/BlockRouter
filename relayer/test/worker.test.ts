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
  deps.store.addUsage(session.address, 1, PROMPT_FOR_270K, 0, 0, NOW_SECS);
  assert.equal((await worker.tick()).get(session.address)?.status, "skipped");
  assert.equal(chain.settlements.length, 0);
});

test("settles raw token counts once pending usage reaches the threshold", async () => {
  const { chain, deps, worker } = setup({ settleThresholdBps: 2_500 });
  const session = openSession(chain, randomAddress(), { reservedAmount: 1_000_000n });
  deps.store.addUsage(session.address, 1, PROMPT_FOR_270K, 10, 0, NOW_SECS);

  const outcome = (await worker.tick()).get(session.address);
  assert.equal(outcome?.status, "settled");
  assert.deepEqual(chain.settlements[0], {
    session,
    lines: [{ modelId: 1, promptTokens: 1_000_000n, completionTokens: 10n }],
  });
  const usage = deps.store.getUsage(session.address)!;
  assert.equal(usage.settleSignature, "sig-1");
  assert.notEqual(usage.settledAt, null);
  assert.equal((await worker.tick()).size, 0, "settled sessions are not retried");
});

test("settles a long session before expiry even below the threshold", async () => {
  const { chain, deps, worker } = setup({ settleBeforeExpirySecs: 600 });
  const session = openSession(chain, randomAddress(), { expiresAt: chain.clock.now + 600n });
  // First used a day ago, so the full configured window applies.
  deps.store.addUsage(session.address, 1, 10, 10, 0, NOW_SECS - 86_400);
  assert.equal((await worker.tick()).get(session.address)?.status, "settled");
});

test("a close request settles, even with zero usage, and kills the key", async () => {
  const { chain, deps, worker, app } = setup();
  const session = openSession(chain, randomAddress());
  const key = issueKey(deps, session);
  const close = await app.request("/v1/session/close", { method: "POST", headers: { Authorization: `Bearer ${key}` } });
  assert.equal(close.status, 202);

  assert.equal((await worker.tick()).get(session.address)?.status, "settled");
  assert.deepEqual(chain.settlements[0], { session, lines: [] });
  const after = await app.request("/v1/session/current", { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(after.status, 402);
  assert.equal(((await after.json()) as any).error.code, "session_expired");
});

test("interval settling is opt-in", async () => {
  const off = setup();
  const offSession = openSession(off.chain, randomAddress());
  off.deps.store.addUsage(offSession.address, 1, 10, 10, 0, NOW_SECS - 10_000);
  assert.equal((await off.worker.tick()).get(offSession.address)?.status, "skipped");

  const on = setup({ settleIntervalSecs: 300 });
  const onSession = openSession(on.chain, randomAddress());
  on.deps.store.addUsage(onSession.address, 1, 10, 10, 0, NOW_SECS - 300);
  assert.equal((await on.worker.tick()).get(onSession.address)?.status, "settled");
});

test("waits for in-flight requests and blocks new ones while settling", async () => {
  const { chain, deps, worker, app } = setup({ settleThresholdBps: 1 });
  const session = openSession(chain, randomAddress());
  const key = issueKey(deps, session);
  deps.store.addUsage(session.address, 1, PROMPT_FOR_270K, 0, 0, NOW_SECS);
  deps.ledger.hold(session.address, 5n);

  assert.equal((await worker.tick()).get(session.address)?.status, "waiting");
  assert.equal(chain.settlements.length, 0);
  const blocked = await app.request("/v1/session/current", { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(((await blocked.json()) as any).error.code, "session_expired");

  // The in-flight request finishes and records its usage before settlement runs.
  deps.store.addUsage(session.address, 1, 0, 7, 0, NOW_SECS);
  deps.ledger.release(session.address, 5n);
  assert.equal((await worker.tick()).get(session.address)?.status, "settled");
  assert.equal(chain.settlements[0].lines[0]!.completionTokens, 7n);
});

test("records unbillable usage when the session is gone or expired, without retrying", async () => {
  const { chain, deps, worker } = setup();
  const gone = openSession(chain, randomAddress());
  deps.store.addUsage(gone.address, 1, 10, 10, 0, NOW_SECS);
  chain.sessions.delete(gone.address);

  const expired = openSession(chain, randomAddress(), { expiresAt: chain.clock.now - 1n });
  deps.store.addUsage(expired.address, 1, 10, 10, 0, NOW_SECS);

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
  deps.store.addUsage(session.address, 1, PROMPT_FOR_270K, 0, 0, NOW_SECS);
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
    first.deps.store.addUsage(session.address, 1, PROMPT_FOR_270K, 3, 0, NOW_SECS);
    first.deps.store.close();

    // New process: fresh store on the same file, same chain state.
    const store = new Store(path);
    const deps = testDeps({ chain: first.chain, config: testConfig({ settleThresholdBps: 1 }), store });
    const worker = new SettlementWorker({ ...deps, ledger: new Ledger(store, first.chain, deps.config.models) });
    assert.equal((await worker.tick()).get(session.address)?.status, "settled");
    assert.equal(first.chain.settlements[0].lines[0]!.completionTokens, 3n);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overrun usage is trimmed line by line to the largest billable amount, never above usage", () => {
  const models = new Map([
    [1, model(1)],
    [2, model(2, { promptRate: 1_000_000n, completionRate: 2_000_000n })],
  ]);
  const line = (modelId: number, prompt: bigint, completion: bigint) => ({ modelId, promptTokens: prompt, completionTokens: completion });
  const cost = (lines: ReturnType<typeof fitToReservation>) =>
    lines.reduce((total, l) => total + charge(l.promptTokens, l.completionTokens, ratesOf(models.get(l.modelId)!)), 0n);

  const fits = [line(1, 100n, 100n), line(2, 10n, 10n)];
  assert.deepEqual(fitToReservation(fits, 1_000n, models), fits);

  const over = fitToReservation([line(1, 1_000n, 10_000n), line(2, 1_000n, 1_000n)], 1_000n, models);
  assert.ok(cost(over) <= 1_000n);
  assert.ok(over[0]!.completionTokens < 10_000n, "first line trimmed");
  assert.deepEqual(over[1], line(2, 0n, 0n), "nothing left for the second line");
  const oneMore = [{ ...over[0]!, completionTokens: over[0]!.completionTokens + 1n }];
  assert.ok(cost(oneMore) > 1_000n, "bills the maximum that fits");

  const promptOnly = fitToReservation([line(1, 10_000_000n, 5n)], 1_000n, models);
  assert.equal(promptOnly[0]!.completionTokens, 0n);
  assert.ok(cost(promptOnly) <= 1_000n);
});

const ratesOf = (m: ReturnType<typeof model>) => ({ promptRate: m.promptRate, completionRate: m.completionRate });

test("the expiry window scales with the session so short sessions are not settled on first use", async () => {
  const { expiryWindow } = await import("../src/worker");
  const config = testConfig({ settleBeforeExpirySecs: 600, workerTickSecs: 15 });
  const usageAt = (firstUsageAt: number) => ({ firstUsageAt }) as Parameters<typeof expiryWindow>[2];
  const sessionUntil = (expiresAt: bigint) => ({ expiresAt }) as Parameters<typeof expiryWindow>[1];

  // A day-long session keeps the configured 10 minutes.
  assert.equal(expiryWindow(config, sessionUntil(BigInt(NOW_SECS + 86_400)), usageAt(NOW_SECS)), 600n);
  // A 20-minute session gets a quarter of it.
  assert.equal(expiryWindow(config, sessionUntil(BigInt(NOW_SECS + 1_200)), usageAt(NOW_SECS)), 300n);
  // A 2-minute session gets the floor: two ticks plus 30 seconds.
  assert.equal(expiryWindow(config, sessionUntil(BigInt(NOW_SECS + 120)), usageAt(NOW_SECS)), 60n);

  const { chain, deps, worker } = setup({ settleBeforeExpirySecs: 600, workerTickSecs: 15 });
  const short = openSession(chain, randomAddress(), { expiresAt: chain.clock.now + 120n });
  deps.store.addUsage(short.address, 1, 10, 10, 0, NOW_SECS);
  assert.equal((await worker.tick()).get(short.address)?.status, "skipped", "not settled on first use");
  chain.clock.now += 61n;
  assert.equal((await worker.tick()).get(short.address)?.status, "settled", "settled inside the final minute");
});
