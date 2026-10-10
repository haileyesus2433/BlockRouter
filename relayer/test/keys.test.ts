import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import { hashKey, MAX_CLOCK_SKEW_SECS, verifyApiKey } from "../src/auth";
import { ApiError } from "../src/errors";
import { fakeChain, NOW_SECS, openSession, randomAddress, signedHeaders, testDeps, testWallet } from "./helpers";

async function setup() {
  const chain = fakeChain();
  const deps = testDeps({ chain });
  const app = createApp(deps);
  const alice = await testWallet();
  const session = openSession(chain, alice.address);
  return { app, chain, deps, alice, session };
}

async function createKey(app: ReturnType<typeof createApp>, wallet: Awaited<ReturnType<typeof testWallet>>, body: unknown) {
  return app.request("/v1/keys", {
    method: "POST",
    headers: await signedHeaders(wallet, "POST", "/v1/keys"),
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

test("creates a session-bound key, returns plaintext once, stores only the hash", async () => {
  const { app, deps, alice, session } = await setup();
  const response = await createKey(app, alice, { name: "opencode", session: session.address });
  assert.equal(response.status, 201);
  const created = (await response.json()) as { id: string; key: string; session: string };
  assert.match(created.key, /^brk_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.session, session.address);

  const stored = deps.store.findKeyByHash(hashKey(created.key));
  assert.equal(stored?.ownerPubkey, alice.address);
  assert.equal(stored?.sessionPubkey, session.address);
  assert.notEqual(stored?.hash, created.key);

  const list = await app.request("/v1/keys", { headers: await signedHeaders(alice, "GET", "/v1/keys") });
  const body = JSON.stringify(await list.json());
  assert.ok(body.includes(created.id));
  assert.ok(!body.includes(created.key), "list must never return the plaintext key");
  assert.ok(!body.includes(stored!.hash), "list must never return the hash");
});

test("rejects requests without a wallet signature", async () => {
  const { app } = await setup();
  const response = await app.request("/v1/keys");
  assert.equal(response.status, 401);
  assert.equal(await errorCode(response), "wallet_auth_required");
});

test("rejects a signature from a different wallet", async () => {
  const { app, alice } = await setup();
  const attacker = await testWallet();
  const headers = await signedHeaders(attacker, "GET", "/v1/keys");
  headers["X-BlockRouter-Address"] = alice.address;
  const response = await app.request("/v1/keys", { headers });
  assert.equal(response.status, 401);
  assert.equal(await errorCode(response), "wallet_auth_invalid");
});

test("rejects a signature made for another method or path", async () => {
  const { app, alice, session } = await setup();
  const response = await app.request("/v1/keys", {
    method: "POST",
    headers: await signedHeaders(alice, "GET", "/v1/keys"),
    body: JSON.stringify({ name: "x", session: session.address }),
  });
  assert.equal(await errorCode(response), "wallet_auth_invalid");
});

test("rejects stale timestamps", async () => {
  const { app, alice } = await setup();
  const response = await app.request("/v1/keys", {
    headers: await signedHeaders(alice, "GET", "/v1/keys", NOW_SECS - MAX_CLOCK_SKEW_SECS - 1),
  });
  assert.equal(await errorCode(response), "wallet_auth_expired");
});

test("validates the request body", async () => {
  const { app, alice, session } = await setup();
  assert.equal((await createKey(app, alice, { session: session.address })).status, 400);
  assert.equal((await createKey(app, alice, { name: "x".repeat(65), session: session.address })).status, 400);
  assert.equal((await createKey(app, alice, { name: "ok", session: "not-an-address" })).status, 400);
});

test("rejects sessions that do not exist, are not owned, use another relayer, or expired", async () => {
  const { app, chain, alice } = await setup();
  const bob = await testWallet();

  const missing = await createKey(app, alice, { name: "k", session: randomAddress() });
  assert.equal(await errorCode(missing), "invalid_session");

  const bobs = openSession(chain, bob.address);
  const notOwner = await createKey(app, alice, { name: "k", session: bobs.address });
  assert.equal(notOwner.status, 403);
  assert.equal(await errorCode(notOwner), "not_session_owner");

  const other = openSession(chain, alice.address, { relayer: randomAddress() });
  assert.equal(await errorCode(await createKey(app, alice, { name: "k", session: other.address })), "wrong_relayer");

  const expired = openSession(chain, alice.address, { expiresAt: chain.clock.now });
  assert.equal(await errorCode(await createKey(app, alice, { name: "k", session: expired.address })), "session_expired");
});

test("revocation is immediate and scoped to the owner", async () => {
  const { app, deps, alice, session } = await setup();
  const created = (await (await createKey(app, alice, { name: "k", session: session.address })).json()) as {
    id: string;
    key: string;
  };
  assert.equal(verifyApiKey(deps.store, `Bearer ${created.key}`).id, created.id);

  const attacker = await testWallet();
  const path = `/v1/keys/${created.id}`;
  const foreign = await app.request(path, { method: "DELETE", headers: await signedHeaders(attacker, "DELETE", path) });
  assert.equal(foreign.status, 404);

  const revoked = await app.request(path, { method: "DELETE", headers: await signedHeaders(alice, "DELETE", path) });
  assert.equal(revoked.status, 200);
  assert.throws(() => verifyApiKey(deps.store, `Bearer ${created.key}`), (e: ApiError) => e.code === "key_revoked");

  const again = await app.request(path, { method: "DELETE", headers: await signedHeaders(alice, "DELETE", path) });
  assert.equal(again.status, 404);
});

test("bearer keys must be present, well formed, and known", () => {
  const { store } = testDeps();
  for (const header of [undefined, "Bearer nope", "brk_live_abc", "Bearer brk_live_unknown"]) {
    assert.throws(() => verifyApiKey(store, header), (e: ApiError) => e.status === 401 && e.code === "invalid_api_key");
  }
});
