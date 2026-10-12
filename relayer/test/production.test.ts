import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { fakeChain, issueKey, openSession, randomAddress, testDeps } from "./helpers";

test("off the local chain the relayer refuses to start on the mock provider unless allowed", () => {
  assert.throws(() => loadConfig({ CLUSTER: "devnet" }), /no upstream provider configured/);
  assert.equal(loadConfig({ CLUSTER: "devnet", ALLOW_MOCK_PROVIDER: "1" }).cluster, "devnet");
  assert.equal(loadConfig({ CLUSTER: "localnet" }).cluster, "localnet");
});

test("CORS origins tolerate a trailing slash", () => {
  const config = loadConfig({ CLUSTER: "localnet", CORS_ORIGINS: "https://app.example.com/, https://b.example.com" });
  assert.deepEqual(config.corsOrigins, ["https://app.example.com", "https://b.example.com"]);
});

test("oversized request bodies are rejected before parsing", async () => {
  const chain = fakeChain();
  const deps = testDeps({ chain });
  const key = issueKey(deps, openSession(chain, randomAddress()));
  const response = await createApp(deps).request("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Content-Length": String(9 * 1024 * 1024) },
    body: "x".repeat(9 * 1024 * 1024),
  });
  assert.equal(response.status, 413);
  assert.equal(((await response.json()) as any).error.code, "request_too_large");
});
