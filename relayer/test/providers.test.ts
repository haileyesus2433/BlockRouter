import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { countPromptTokens } from "../src/providers/mock";
import type { ChatRequest, Chunk, Provider } from "../src/providers/types";
import { fakeChain, issueKey, openSession, randomAddress, testDeps } from "./helpers";

const EXAMPLE = fileURLToPath(new URL("../providers.example.json", import.meta.url));
const KEYS = { DEEPSEEK_API_KEY: "sk-deepseek-SECRET", OPENROUTER_API_KEY: "sk-or-SECRET" };

function withFile(contents: unknown, run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "providers-"));
  try {
    const path = join(dir, "providers.json");
    writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the example config routes each model to its own provider", () => {
  const config = loadConfig({ CLUSTER: "devnet", PROVIDERS_FILE: EXAMPLE, ...KEYS });
  assert.deepEqual(Object.keys(config.providers), ["deepseek", "openrouter"]);
  assert.equal(config.providers.deepseek!.apiKey, KEYS.DEEPSEEK_API_KEY);
  const byAlias = Object.fromEntries(config.models.map((m) => [m.alias, m]));
  assert.deepEqual(
    [byAlias["deepseek-v3"]!.provider, byAlias["deepseek-v3"]!.upstream],
    ["deepseek", "deepseek-chat"],
  );
  assert.deepEqual(
    [byAlias["llama-3.3-70b"]!.provider, byAlias["llama-3.3-70b"]!.upstream],
    ["openrouter", "meta-llama/llama-3.3-70b-instruct"],
  );
});

test("models without a provider are marked unavailable when a registry is configured", () => {
  withFile(
    {
      providers: { deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" } },
      models: { "deepseek-v3": { provider: "deepseek", upstream: "deepseek-chat" } },
    },
    (path) => {
      const config = loadConfig({ CLUSTER: "devnet", PROVIDERS_FILE: path, ...KEYS });
      assert.deepEqual(
        config.models.map((m) => [m.alias, m.available]),
        [
          ["deepseek-v3", true],
          ["llama-3.3-70b", false],
        ],
      );
    },
  );
});

for (const [name, contents, env, message] of [
  ["a missing key variable", null, { DEEPSEEK_API_KEY: "x".repeat(10) }, /OPENROUTER_API_KEY set in the environment/],
  ["an unknown provider", { providers: {}, models: { "deepseek-v3": { provider: "nope", upstream: "x" } } }, KEYS, /unknown provider "nope"/],
  ["a model outside the deployment", { providers: {}, models: { "gpt-9": { provider: "x", upstream: "y" } } }, KEYS, /unknown provider|not in deployments/],
  ["a bad base URL", { providers: { a: { baseUrl: "ftp://x", apiKeyEnv: "DEEPSEEK_API_KEY" } }, models: {} }, KEYS, /baseUrl must be/],
  ["invalid JSON", "{ nope", KEYS, /cannot read PROVIDERS_FILE/],
  ["a key pasted as apiKeyEnv", { providers: { a: { baseUrl: "https://x.example", apiKeyEnv: "sk-SECRET-123" } }, models: {} }, KEYS, /must be the NAME of an environment variable/],
  ["missing sections", { providers: {} }, KEYS, /needs "providers" and "models"/],
] as const) {
  test(`provider config rejects ${name} without echoing secrets`, () => {
    const run = (path: string) =>
      assert.throws(
        () => loadConfig({ CLUSTER: "devnet", PROVIDERS_FILE: path, ...env }),
        (error: Error) => message.test(error.message) && !error.message.includes("SECRET"),
      );
    if (contents === null) run(EXAMPLE);
    else withFile(contents, run);
  });
}

test("PROVIDERS_FILE and UPSTREAM_* cannot be combined", () => {
  assert.throws(
    () => loadConfig({ CLUSTER: "devnet", PROVIDERS_FILE: EXAMPLE, ...KEYS, UPSTREAM_BASE_URL: "https://x.example", UPSTREAM_API_KEY: "k" }),
    /either PROVIDERS_FILE or UPSTREAM/,
  );
});

class Recording implements Provider {
  readonly requests: string[] = [];
  constructor(readonly id: string) {}
  countTokens(request: ChatRequest) {
    return countPromptTokens(request);
  }
  async *chat(request: ChatRequest): AsyncIterable<Chunk> {
    this.requests.push(request.model);
    yield { type: "delta", content: `from ${this.id}` };
    yield { type: "usage", usage: { promptTokens: 5, completionTokens: 2 } };
  }
}

test("requests reach the provider and upstream model configured for their alias", async () => {
  const config = loadConfig({ CLUSTER: "devnet", PROVIDERS_FILE: EXAMPLE, ...KEYS });
  const deepseek = new Recording("deepseek");
  const openrouter = new Recording("openrouter");
  const chain = fakeChain();
  const deps = testDeps({ chain, config: { ...config, rateLimitPerMinute: 100 }, providers: new Map<string, Provider>([["deepseek", deepseek], ["openrouter", openrouter]]) });
  const app = createApp(deps);
  const session = openSession(chain, randomAddress(), { allowedModels: [1, 2] });
  const key = issueKey(deps, session);
  const chat = async (model: string) =>
    ((await (
      await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      })
    ).json()) as any).choices[0].message.content;

  assert.equal(await chat("deepseek-v3"), "from deepseek");
  assert.equal(await chat("llama-3.3-70b"), "from openrouter");
  assert.deepEqual(deepseek.requests, ["deepseek-chat"]);
  assert.deepEqual(openrouter.requests, ["meta-llama/llama-3.3-70b-instruct"]);

  const health = (await (await app.request("/health")).json()) as any;
  assert.deepEqual(health.providers, ["deepseek", "openrouter"]);
});

test("unavailable models are hidden from /v1/models and refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "providers-"));
  try {
    const path = join(dir, "providers.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: { deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" } },
        models: { "deepseek-v3": { provider: "deepseek", upstream: "deepseek-chat" } },
      }),
    );
    const config = loadConfig({ CLUSTER: "devnet", PROVIDERS_FILE: path, ...KEYS });
    const chain = fakeChain();
    const deps = testDeps({ chain, config, providers: new Map<string, Provider>([["deepseek", new Recording("deepseek")]]) });
    const app = createApp(deps);
    const models = (await (await app.request("/v1/models")).json()) as any;
    assert.deepEqual(models.data.map((m: any) => m.id), ["deepseek-v3"]);

    const session = openSession(chain, randomAddress(), { allowedModels: [1, 2] });
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${issueKey(deps, session)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
