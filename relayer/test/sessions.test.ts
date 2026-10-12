import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import { fakeChain, issueKey, NOW_SECS, openSession, signedHeaders, testDeps, testWallet } from "./helpers";

async function setup() {
  const chain = fakeChain();
  const deps = testDeps({ chain });
  const alice = await testWallet();
  const session = openSession(chain, alice.address, { allowedModels: [1, 2] });
  issueKey(deps, session);
  return { app: createApp(deps), deps, chain, alice, session };
}

test("the dashboard origin may call the API from a browser", async () => {
  const { app } = await setup();
  const preflight = await app.request("/v1/sessions", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "x-blockrouter-signature",
    },
  });
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "http://localhost:5173");
  assert.match(preflight.headers.get("Access-Control-Allow-Headers") ?? "", /X-BlockRouter-Signature/i);

  const other = await app.request("/health", { headers: { Origin: "https://evil.example" } });
  assert.notEqual(other.headers.get("Access-Control-Allow-Origin"), "https://evil.example");
});

test("lists the wallet's sessions with per-model usage and settlement status", async () => {
  const { app, deps, alice, session } = await setup();
  deps.store.addUsage(session.address, 1, 1_000_000, 0, 0, NOW_SECS);
  const response = await app.request("/v1/sessions", { headers: await signedHeaders(alice, "GET", "/v1/sessions") });
  assert.equal(response.status, 200);
  const [entry] = ((await response.json()) as any).data;
  assert.equal(entry.session, session.address);
  assert.equal(entry.open, true);
  assert.deepEqual(entry.models, ["deepseek-v3", "llama-3.3-70b"]);
  assert.equal(entry.pending, 270_000);
  assert.equal(entry.remaining, 5_000_000 - 270_000);
  assert.equal(entry.settle_signature, null);

  deps.store.markSettled(session.address, "sig-xyz", NOW_SECS);
  const after = ((await (await app.request("/v1/sessions", { headers: await signedHeaders(alice, "GET", "/v1/sessions") })).json()) as any).data[0];
  assert.equal(after.settle_signature, "sig-xyz");
});

test("another wallet sees none of these sessions and cannot close them", async () => {
  const { app, session } = await setup();
  const bob = await testWallet();
  const list = (await (await app.request("/v1/sessions", { headers: await signedHeaders(bob, "GET", "/v1/sessions") })).json()) as any;
  assert.deepEqual(list.data, []);

  const path = `/v1/sessions/${session.address}/close`;
  const close = await app.request(path, { method: "POST", headers: await signedHeaders(bob, "POST", path) });
  assert.equal(close.status, 404);
});

test("the owner can close a session without its API key", async () => {
  const { app, deps, alice, session } = await setup();
  const path = `/v1/sessions/${session.address}/close`;
  const response = await app.request(path, { method: "POST", headers: await signedHeaders(alice, "POST", path) });
  assert.equal(response.status, 202);
  assert.equal(deps.store.getUsage(session.address)?.closeRequested, true);
});

test("session endpoints require a wallet signature", async () => {
  const { app } = await setup();
  assert.equal((await app.request("/v1/sessions")).status, 401);
});
