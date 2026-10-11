import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createRedactor } from "../src/redact";
import { SettlementWorker } from "../src/worker";
import { fakeChain, NOW_SECS, openSession, randomAddress, testConfig, testDeps } from "./helpers";

const SECRET = "SECRET_SENTINEL_9f8e7d";

function captureConsole(run: () => Promise<void>) {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  return run()
    .finally(() => Object.assign(console, original))
    .then(() => lines.join("\n"));
}

test("unknown routes return a JSON 404 without echoing the path", async () => {
  const app = createApp(testDeps());
  const response = await app.request(`/v1/${SECRET}`);
  assert.equal(response.status, 404);
  const body = await response.text();
  assert.equal(JSON.parse(body).error.code, "not_found");
  assert.ok(!body.includes(SECRET));
});

test("unexpected exceptions never reach the response or the logs", async () => {
  const chain = fakeChain();
  chain.getModel = async () => {
    throw new Error(`upstream said: api-key=${SECRET}`);
  };
  const app = createApp(testDeps({ chain }));
  let body = "";
  const logs = await captureConsole(async () => {
    const response = await app.request("/v1/models");
    assert.equal(response.status, 500);
    body = await response.text();
  });
  assert.equal(JSON.parse(body).error.code, "internal_error");
  assert.ok(!body.includes(SECRET));
  assert.ok(!logs.includes(SECRET), "secret leaked into logs");
});

test("redactor removes RPC URLs, their query strings, and API keys", () => {
  const redact = createRedactor([`https://rpc.example.com/v2/${SECRET}?api-key=${SECRET}`, `sk-${SECRET}`, "short"]);
  const out = redact(
    `fetch https://rpc.example.com/v2/${SECRET}?api-key=${SECRET} failed; key sk-${SECRET}; q api-key=${SECRET}; short`,
  );
  assert.ok(!out.includes(SECRET), out);
  assert.ok(out.includes("short"), "values under 8 chars are not treated as secrets");
});

test("settlement errors are redacted before they are logged or stored", async () => {
  const chain = fakeChain();
  const deps = testDeps({ chain, config: testConfig({ settleThresholdBps: 1 }) });
  const session = openSession(chain, randomAddress());
  deps.store.addUsage(session.address, 1_000_000, 0, 0, NOW_SECS);
  chain.failSettle = new Error(`request to https://rpc.example.com/?api-key=${SECRET} failed`);
  const worker = new SettlementWorker({ ...deps, redact: createRedactor([`https://rpc.example.com/?api-key=${SECRET}`]) });

  const logs = await captureConsole(async () => {
    await worker.tick();
  });
  assert.ok(!logs.includes(SECRET), "secret leaked into logs");
  assert.ok(!deps.store.getUsage(session.address)!.lastError!.includes(SECRET), "secret stored in the database");
});

for (const [name, env, message] of [
  ["HOST", { HOST: `${SECRET}.example` }, /HOST must be/],
  ["PORT", { PORT: "70000" }, /PORT must be/],
  ["RPC_URL", { RPC_URL: `ftp://${SECRET}` }, /RPC_URL must be/],
  ["RPC_URL credentials", { RPC_URL: `https://user:${SECRET}@rpc.example.com` }, /RPC_URL must be/],
  ["UPSTREAM_BASE_URL", { UPSTREAM_BASE_URL: `file:///${SECRET}`, UPSTREAM_API_KEY: SECRET }, /UPSTREAM_BASE_URL must be/],
  ["CLUSTER", { CLUSTER: SECRET }, /CLUSTER must be/],
] as const) {
  test(`config rejects an invalid ${name} without echoing it`, () => {
    assert.throws(
      () => loadConfig({ CLUSTER: "devnet", ...env }),
      (error: Error) => message.test(error.message) && !error.message.includes(SECRET),
    );
  });
}

test("config accepts localhost and explicit IPs", () => {
  assert.equal(loadConfig({ CLUSTER: "devnet", HOST: "localhost" }).host, "localhost");
  assert.equal(loadConfig({ CLUSTER: "devnet", HOST: "0.0.0.0", PORT: "3000" }).port, 3000);
});

test("startup failures exit non-zero without revealing secrets", () => {
  const server = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", server], {
    encoding: "utf8",
    env: { ...process.env, CLUSTER: "devnet", RPC_URL: `https://user:${SECRET}@rpc.example.com` },
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RPC_URL must be/);
  assert.ok(!(result.stdout + result.stderr).includes(SECRET));

  const missingKey = spawnSync(process.execPath, ["--import", "tsx", server], {
    encoding: "utf8",
    env: { ...process.env, CLUSTER: "devnet", RELAYER_KEYPAIR: `/nonexistent/${SECRET}.json` },
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  assert.notEqual(missingKey.status, 0);
  assert.match(missingKey.stderr, /startup failed/);
  assert.ok(!(missingKey.stdout + missingKey.stderr).includes(SECRET));
});
