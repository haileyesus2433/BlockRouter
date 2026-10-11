import {
  type Address,
  address,
  generateKeyPair,
  getAddressDecoder,
  getAddressFromPublicKey,
  getBase58Decoder,
  getUtf8Encoder,
  signBytes,
} from "@solana/kit";

import { randomBytes } from "node:crypto";

import { generateKey, hashKey, walletAuthMessage } from "../src/auth";

import type { Chain, ModelState, SessionState, SettleInput } from "../src/chain/types";
import type { Config } from "../src/config";
import type { Deps } from "../src/app";
import type { Provider } from "../src/providers/types";
import { Ledger } from "../src/ledger";
import { MockProvider } from "../src/providers/mock";
import { Store } from "../src/store";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
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
    relayer: address("8vunfgvssmtyqGFLxArjSAts9ZMZMdhCPP1bnzqUdrEC"),
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

export const NOW_SECS = 1_800_000_000;

export function testDeps(overrides: Partial<Deps> = {}): Deps {
  const config = overrides.config ?? testConfig();
  const chain = overrides.chain ?? fakeChain();
  const store = overrides.store ?? new Store(":memory:");
  return {
    config,
    chain,
    provider: new MockProvider(),
    store,
    ledger: new Ledger(store, chain, config.models),
    nowSecs: () => NOW_SECS,
    ...overrides,
  };
}

export type TestWallet = { address: Address; privateKey: CryptoKey };

export async function testWallet(): Promise<TestWallet> {
  const pair = await generateKeyPair();
  return { address: await getAddressFromPublicKey(pair.publicKey), privateKey: pair.privateKey };
}

export async function signedHeaders(
  wallet: TestWallet,
  method: string,
  path: string,
  timestamp = NOW_SECS,
): Promise<Record<string, string>> {
  const message = getUtf8Encoder().encode(walletAuthMessage(wallet.address, method, path, timestamp));
  const signature = await signBytes(wallet.privateKey, message);
  return {
    "X-BlockRouter-Address": wallet.address,
    "X-BlockRouter-Timestamp": String(timestamp),
    "X-BlockRouter-Signature": getBase58Decoder().decode(signature),
    "Content-Type": "application/json",
  };
}

let sessionCounter = 0;

export function randomAddress(): Address {
  return getAddressDecoder().decode(randomBytes(32));
}

export function openSession(chain: FakeChain, owner: Address, overrides: Partial<SessionState> = {}): SessionState {
  sessionCounter += 1;
  const session: SessionState = {
    address: randomAddress(),
    vault: randomAddress(),
    payerKind: "vault",
    beneficiary: owner,
    relayer: chain.relayer,
    reservedAmount: 5_000_000n,
    sessionId: BigInt(sessionCounter),
    expiresAt: chain.clock.now + 86_400n,
    allowedModels: [1],
    ...overrides,
  };
  chain.sessions.set(session.address, session);
  return session;
}

/** Inserts a key straight into the store and returns its plaintext. */
export function issueKey(deps: Deps, session: SessionState, defaultMaxTokens: number | null = null): string {
  const { id, key } = generateKey();
  deps.store.insertKey({
    id,
    name: "test",
    hash: hashKey(key),
    sessionPubkey: session.address,
    ownerPubkey: session.beneficiary,
    createdAt: NOW_SECS,
    revokedAt: null,
    defaultMaxTokens,
  });
  return key;
}
