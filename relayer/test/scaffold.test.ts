import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { charge, effectiveRates } from "../src/pricing";
import { fakeChain, model, testConfig, testProvider } from "./helpers";

test("health reports cluster and provider", async () => {
  const app = createApp({ config: testConfig(), chain: fakeChain(), provider: testProvider() });
  const response = await app.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", cluster: "localnet", provider: "test" });
});

test("charge mirrors the on-chain math and rounds down", () => {
  const rates = { promptRate: 270_000n, completionRate: 1_100_000n };
  assert.equal(charge(1_000_000n, 0n, rates), 270_000n);
  assert.equal(charge(1_000n, 500n, rates), 270n + 550n);
  assert.equal(charge(1n, 0n, { promptRate: 1n, completionRate: 1n }), 0n);
  assert.equal(charge(0n, 0n, rates), 0n);
});

test("effective rates switch to pending once the timelock passes", () => {
  const pending = { ...model(1), pendingPromptRate: 9n, pendingCompletionRate: 10n, effectiveAt: 100n };
  assert.deepEqual(effectiveRates(pending, 99n), { promptRate: 270_000n, completionRate: 1_100_000n });
  assert.deepEqual(effectiveRates(pending, 100n), { promptRate: 9n, completionRate: 10n });
  assert.deepEqual(effectiveRates(model(1), 10_000n), { promptRate: 270_000n, completionRate: 1_100_000n });
});

test("config reads models from the deployment and maps upstream names", () => {
  const config = loadConfig({
    CLUSTER: "devnet",
    UPSTREAM_MODELS: "deepseek-v3=deepseek-chat",
  });
  assert.equal(config.models.find((m) => m.alias === "deepseek-v3")?.upstream, "deepseek-chat");
  assert.equal(config.models.find((m) => m.alias === "llama-3.3-70b")?.upstream, "llama-3.3-70b");
  assert.equal(config.upstream, null);
});

test("config rejects a half-configured upstream", () => {
  assert.throws(() => loadConfig({ CLUSTER: "devnet", UPSTREAM_BASE_URL: "https://x" }), /UPSTREAM_API_KEY/);
});
