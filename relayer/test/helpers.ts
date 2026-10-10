import type { Address } from "@solana/kit";

import type { Chain, ModelState, SessionState, SettleInput } from "../src/chain/types";
import type { Config } from "../src/config";
import type { Provider } from "../src/providers/types";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    cluster: "localnet",
    rpcUrl: "http://127.0.0.1:8899",
    relayerKeypair: "unused",
    dbPath: ":memory:",
    models: [
      { id: 1, alias: "deepseek-v3", upstream: "deepseek-chat" },
      { id: 2, alias: "llama-3.3-70b", upstream: "llama-3.3-70b" },
    ],
    settleThresholdBps: 8_000,
    settleBeforeExpirySecs: 600,
    settleIntervalSecs: 0,
    workerTickSecs: 15,
    rateLimitPerMinute: 1_000,
    upstream: null,
    ...overrides,
  };
}

export function model(modelId: number, overrides: Partial<ModelState> = {}): ModelState {
  return {
    modelId,
    promptRate: 270_000n,
    completionRate: 1_100_000n,
    pendingPromptRate: 0n,
    pendingCompletionRate: 0n,
    effectiveAt: 0n,
    isActive: true,
    ...overrides,
  };
}

export type FakeChain = Chain & {
  sessions: Map<string, SessionState>;
  models: Map<number, ModelState>;
  settlements: SettleInput[];
  clock: { now: bigint };
  failSettle: Error | null;
};

export function fakeChain(): FakeChain {
  const sessions = new Map<string, SessionState>();
  const models = new Map<number, ModelState>([
    [1, model(1)],
    [2, model(2, { promptRate: 590_000n, completionRate: 790_000n })],
  ]);
  const settlements: SettleInput[] = [];
  const chain: FakeChain = {
    sessions,
    models,
    settlements,
    clock: { now: 1_800_000_000n },
    failSettle: null,
    async getSession(address: Address) {
      return sessions.get(address) ?? null;
    },
    async getModel(modelId: number) {
      return models.get(modelId) ?? null;
    },
    async settle(input: SettleInput) {
      if (chain.failSettle) throw chain.failSettle;
      settlements.push(input);
      sessions.delete(input.session.address);
      return `sig-${settlements.length}`;
    },
    async now() {
      return chain.clock.now;
    },
  };
  return chain;
}

export function testProvider(): Provider {
  return {
    id: "test",
    async *chat() {
      yield { type: "usage", usage: { promptTokens: 0, completionTokens: 0 } };
    },
    countTokens: () => 0,
  };
}
