import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app";
import { clientLabel } from "../src/routes/chat";
import { MockProvider } from "../src/providers/mock";
import { fakeChain, issueKey, openSession, signedHeaders, testDeps, testWallet } from "./helpers";

const SECRET = "activity log must never keep this prompt";

async function setup() {
  const chain = fakeChain();
  const deps = testDeps({ chain, provider: new MockProvider({ reply: "one two three" }) });
  const alice = await testWallet();
  const session = openSession(chain, alice.address, { allowedModels: [1, 2] });
  const key = issueKey(deps, session);
  return { app: createApp(deps), deps, alice, session, key };
}

function chat(app: ReturnType<typeof createApp>, key: string, model: string, headers: Record<string, string> = {}) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: SECRET }] }),
  });
}

test("each served request is logged with its model, tokens, charge, and client, newest first", async () => {
  const { app, key } = await setup();
  const first = await chat(app, key, "deepseek-v3", { "User-Agent": "curl/8.9.1" });
  const second = await chat(app, key, "llama-3.3-70b", { "X-BlockRouter-Source": "playground" });

  const response = await app.request("/v1/session/requests", { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.deepEqual(
    body.data.map((entry: any) => [entry.model, entry.client, entry.key_name]),
    [
      ["llama-3.3-70b", "playground", "test"],
      ["deepseek-v3", "curl", "test"],
    ],
  );
  assert.equal(body.data[0].charge, Number(second.headers.get("X-BlockRouter-Charge")));
  assert.equal(body.data[1].charge, Number(first.headers.get("X-BlockRouter-Charge")));
  assert.ok(body.data[1].prompt_tokens > 0 && body.data[1].completion_tokens > 0);
  assert.ok(!JSON.stringify(body).includes(SECRET), "no prompt content");
});

test("failed upstream requests are not logged", async () => {
  const chain = fakeChain();
  const deps = testDeps({ chain, provider: new MockProvider({ failAfter: 0 }) });
  const session = openSession(chain, (await testWallet()).address);
  const key = issueKey(deps, session);
  const app = createApp(deps);
  assert.equal((await chat(app, key, "deepseek-v3")).status, 502);
  const body = (await (await app.request("/v1/session/requests", { headers: { Authorization: `Bearer ${key}` } })).json()) as any;
  assert.deepEqual(body.data, []);
});

test("the limit is bounded", async () => {
  const { app, key } = await setup();
  for (const limit of ["0", "201", "x"]) {
    const response = await app.request(`/v1/session/requests?limit=${limit}`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 400);
  }
});

test("the owner can read a session's activity with a wallet signature; other wallets cannot", async () => {
  const { app, key, alice, session } = await setup();
  await chat(app, key, "deepseek-v3");
  const path = `/v1/sessions/${session.address}/requests`;

  const own = await app.request(path, { headers: await signedHeaders(alice, "GET", path) });
  assert.equal(own.status, 200);
  assert.equal(((await own.json()) as any).data.length, 1);

  const bob = await testWallet();
  const other = await app.request(path, { headers: await signedHeaders(bob, "GET", path) });
  assert.equal(other.status, 404);
});

test("client labels come from an explicit source or a coarse user agent match", () => {
  assert.equal(clientLabel("Playground", undefined), "playground");
  assert.equal(clientLabel("bad label!", "curl/8.0"), "curl");
  assert.equal(clientLabel(undefined, "opencode/1.2 ai-sdk/openai-compatible"), "opencode");
  assert.equal(clientLabel(undefined, "ai-sdk/openai-compatible/1.0"), "ai-sdk");
  assert.equal(clientLabel(undefined, "OpenAI/Python 1.40.0"), "openai-sdk");
  assert.equal(clientLabel(undefined, undefined), "other");
});
