import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createApp } from "../src/app";
import { hashKey } from "../src/auth";
import { MockProvider } from "../src/providers/mock";
import { Store } from "../src/store";
import { fakeChain, issueKey, openSession, randomAddress, signedHeaders, testDeps, testWallet } from "./helpers";

async function setup() {
  const chain = fakeChain();
  const deps = testDeps({ chain, provider: new MockProvider({ reply: "a b c d e f g h i j" }) });
  const alice = await testWallet();
  const session = openSession(chain, alice.address);
  return { app: createApp(deps), deps, chain, alice, session };
}

async function createKey(app: ReturnType<typeof createApp>, wallet: Awaited<ReturnType<typeof testWallet>>, body: object) {
  return app.request("/v1/keys", {
    method: "POST",
    headers: await signedHeaders(wallet, "POST", "/v1/keys"),
    body: JSON.stringify(body),
  });
}

async function patchKey(app: ReturnType<typeof createApp>, wallet: Awaited<ReturnType<typeof testWallet>>, id: string, body: object) {
  const path = `/v1/keys/${id}`;
  return app.request(path, { method: "PATCH", headers: await signedHeaders(wallet, "PATCH", path), body: JSON.stringify(body) });
}

test("keys store, list, update, and reset a default max_tokens", async () => {
  const { app, deps, alice, session } = await setup();
  const created = await createKey(app, alice, { name: "opencode", session: session.address, max_tokens: 16_000 });
  assert.equal(created.status, 201);
  const { id, key, max_tokens } = (await created.json()) as { id: string; key: string; max_tokens: number };
  assert.equal(max_tokens, 16_000);
  assert.equal(deps.store.findKeyByHash(hashKey(key))?.defaultMaxTokens, 16_000);

  assert.equal((await patchKey(app, alice, id, { max_tokens: 32_000 })).status, 200);
  assert.equal(deps.store.findKeyByHash(hashKey(key))?.defaultMaxTokens, 32_000);

  const list = (await (await app.request("/v1/keys", { headers: await signedHeaders(alice, "GET", "/v1/keys") })).json()) as any;
  assert.equal(list.data[0].max_tokens, 32_000);

  assert.equal((await patchKey(app, alice, id, { max_tokens: null })).status, 200);
  assert.equal(deps.store.findKeyByHash(hashKey(key))?.defaultMaxTokens, null);
});

test("max_tokens must be a sane positive integer, and only the owner can change it", async () => {
  const { app, alice, session } = await setup();
  for (const max_tokens of [0, -5, 1.5, "100", 200_001]) {
    assert.equal((await createKey(app, alice, { name: "k", session: session.address, max_tokens })).status, 400, String(max_tokens));
  }
  const { id } = (await (await createKey(app, alice, { name: "k", session: session.address })).json()) as { id: string };
  assert.equal((await patchKey(app, alice, id, {})).status, 400);
  assert.equal((await patchKey(app, alice, id, { max_tokens: 0 })).status, 400);
  const attacker = await testWallet();
  assert.equal((await patchKey(app, attacker, id, { max_tokens: 10 })).status, 404);
});

test("chat uses the key's default when the request omits max_tokens, and the request wins when set", async () => {
  const { app, deps, chain } = await setup();
  const session = openSession(chain, randomAddress());
  const key = issueKey(deps, session, 3);
  const call = (body: object) =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v3", messages: [{ role: "user", content: "go" }], ...body }),
    });

  const keyDefault = (await (await call({})).json()) as any;
  assert.equal(keyDefault.usage.completion_tokens, 3);
  assert.equal(keyDefault.choices[0].finish_reason, "length");

  const explicit = (await (await call({ max_tokens: 6 })).json()) as any;
  assert.equal(explicit.usage.completion_tokens, 6);
});

test("an older database gains the column on startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "relayer-"));
  try {
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
      session_pubkey TEXT NOT NULL, owner_pubkey TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER)`);
    old.prepare("INSERT INTO api_keys VALUES ('key_old', 'old', 'h', 's', 'o', 1, NULL)").run();
    old.close();

    const store = new Store(path);
    assert.equal(store.findKeyByHash("h")?.defaultMaxTokens, null);
    assert.ok(store.setDefaultMaxTokens("key_old", "o", 8_000));
    assert.equal(store.findKeyByHash("h")?.defaultMaxTokens, 8_000);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
