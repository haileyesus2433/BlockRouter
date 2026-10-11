import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { createProgramClient } from "../src/client.js";
import type { Provider, ChatRequest, ChatChunk } from "../src/provider.js";

const programId = "7maTNWbtCpuCXeRUVCNDR2a9YU7kaeUqtvrqz4ustyyi";
const secret = "TEST_ONLY_SECRET_SENTINEL";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "blockrouter-relayer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const idlPath = join(dir, "idl.json");
  await writeFile(
    idlPath,
    JSON.stringify({
      address: programId,
      metadata: { name: "blockrouter", version: "0.1.0", spec: "0.1.0" },
      instructions: [],
    }),
  );
  return { dir, idlPath };
}

test("GET /health returns liveness JSON without contacting RPC", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Network forbidden");
  });
  const response = await createApp().request("/health");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "blockrouter-relayer",
  });
});

test("unknown routes return JSON 404 without echoing the URL", async () => {
  const response = await createApp().request(`/missing?api_key=${secret}`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("HTTP adapter serves health and sanitized errors on a real local listener", async (t) => {
  const logs: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const)
    t.mock.method(console, method, (...args: unknown[]) => logs.push(args));
  const app = createApp();
  app.get("/failure", () => {
    throw new Error(`Upstream credential: ${secret}`);
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "blockrouter-relayer",
  });
  const failure = await fetch(`http://127.0.0.1:${port}/failure`);
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), { error: "Internal server error" });
  assert.deepEqual(logs, []);
});

test("exceptions containing upstream secrets never appear in HTTP responses or logs", async (t) => {
  const logs: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const)
    t.mock.method(console, method, (...args: unknown[]) => logs.push(args));
  const app = createApp();
  app.get("/failure", () => {
    throw new Error(`Upstream Authorization: Bearer ${secret}`);
  });
  const response = await app.request("/failure");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal server error" });
  assert.deepEqual(logs, []);
});

test("app import works without credentials or live RPC", () => {
  const url = new URL("../src/app.js", import.meta.url).href;
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `globalThis.fetch = () => { throw new Error('Network forbidden'); }; const {createApp} = await import(${JSON.stringify(url)}); const r = await createApp().request('/health'); if (r.status !== 200) throw new Error('Unhealthy'); console.log('ok');`,
    ],
    { env, encoding: "utf8", cwd: tmpdir() },
  );
  assert.equal(output.trim(), "ok");
});

test("config defaults match Anchor.toml and require no upstream credentials", async () => {
  const config = await loadConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3000);
  assert.equal(config.cluster, "localnet");
  assert.equal(config.rpcUrl, "http://127.0.0.1:8899");
  assert.equal(config.programId, programId);
  assert.equal(config.providerApiKey, undefined);
  assert.ok(config.idlPath.endsWith("/target/idl/blockrouter.json"));
});

test("config accepts explicit env overrides and takes API keys only from the supplied environment", async () => {
  const config = await loadConfig({
    HOST: "0.0.0.0",
    PORT: "8080",
    SOLANA_CLUSTER: "devnet",
    RPC_URL: `https://example.com/rpc?key=${secret}`,
    PROGRAM_ID: programId,
    IDL_PATH: "/tmp/selected-idl.json",
    OPENAI_API_KEY: secret,
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8080);
  assert.equal(config.cluster, "devnet");
  assert.equal(config.rpcUrl, `https://example.com/rpc?key=${secret}`);
  assert.equal(config.programId, programId);
  assert.equal(config.idlPath, "/tmp/selected-idl.json");
  assert.equal(config.providerApiKey, secret);
  assert.equal((await loadConfig({})).providerApiKey, undefined);
  assert.equal(
    (await loadConfig({ OPENAI_API_KEY: "" })).providerApiKey,
    undefined,
  );
});

test("all clusters select their standard endpoints", async () => {
  for (const [cluster, rpcUrl] of Object.entries({
    localnet: "http://127.0.0.1:8899",
    devnet: "https://api.devnet.solana.com",
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
  })) {
    assert.equal(
      (await loadConfig({ SOLANA_CLUSTER: cluster })).rpcUrl,
      rpcUrl,
    );
  }
});

for (const [name, values, expected] of [
  ["port", ["0", "65536", "1.5", "-1", "", secret], /PORT/],
  ["host", ["", "https://example.com", secret], /HOST/],
  ["cluster", ["testnet", "__proto__", "DEVNET", secret], /SOLANA_CLUSTER/],
  [
    "RPC",
    [
      "not a URL",
      "https:example.com",
      "file:///tmp/rpc",
      `https://${secret}@example.com`,
      `https://example.com/#${secret}`,
    ],
    /RPC_URL/,
  ],
  ["program address", [secret, "bad address"], /PROGRAM_ID/],
] as const) {
  test(`config rejects invalid ${name} without exposing supplied values`, async () => {
    const field = {
      port: "PORT",
      host: "HOST",
      cluster: "SOLANA_CLUSTER",
      RPC: "RPC_URL",
      "program address": "PROGRAM_ID",
    }[name];
    for (const value of values) {
      await assert.rejects(
        loadConfig({ [field]: value, OPENAI_API_KEY: secret }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.match(error.message, expected);
          assert.ok(!error.message.includes(secret));
          return true;
        },
      );
    }
  });
}

test("config rejects valid but unauthorized program-address overrides", async () => {
  await assert.rejects(
    loadConfig({ PROGRAM_ID: "11111111111111111111111111111111" }),
    /must match Anchor.toml/,
  );
});

test("config rejects empty IDL paths and whitespace-only provider keys", async () => {
  await assert.rejects(
    loadConfig({ IDL_PATH: " " }),
    /IDL_PATH must not be empty/,
  );
  await assert.rejects(
    loadConfig({ OPENAI_API_KEY: " \n " }),
    /OPENAI_API_KEY must not be blank/,
  );
});

test("Anchor config failures are sanitized", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    loadConfig({}, join(f.dir, "missing")),
    /Cannot read Anchor.toml/,
  );
  const path = join(f.dir, "Anchor.toml");
  await writeFile(path, `MALFORMED ${secret}`);
  await assert.rejects(loadConfig({}, path), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test("read-only program client initializes from the correct IDL without RPC", async (t) => {
  const f = await fixture(t);
  const config = await loadConfig({ IDL_PATH: f.idlPath });
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    throw new Error("Network forbidden");
  });
  const client = await createProgramClient(config);
  assert.equal(client.program.programId.toBase58(), programId);
  assert.equal(client.program.idl.address, programId);
  assert.equal(client.program.provider.wallet, undefined);
  assert.equal(client.program.provider.sendAndConfirm, undefined);
  assert.ok(client.rpc);
  assert.equal(calls, 0);
});

test("program client rejects missing, malformed and inconsistent IDL safely", async (t) => {
  const f = await fixture(t);
  const config = await loadConfig({ IDL_PATH: f.idlPath });
  await assert.rejects(
    createProgramClient({ ...config, idlPath: join(f.dir, "missing") }),
    /Run anchor build/,
  );
  for (const value of [`${secret} invalid JSON`, "null", "[]", "{}"]) {
    await writeFile(f.idlPath, value);
    await assert.rejects(createProgramClient(config), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
  await writeFile(
    f.idlPath,
    JSON.stringify({ address: "11111111111111111111111111111111" }),
  );
  await assert.rejects(
    createProgramClient(config),
    /IDL program address must match/,
  );
  await writeFile(
    f.idlPath,
    JSON.stringify({ address: programId, instructions: "invalid" }),
  );
  await assert.rejects(createProgramClient(config), /invalid or unsupported/);
  await assert.rejects(
    createProgramClient({ ...config, rpcUrl: `file:///${secret}` }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("startup config errors exit nonzero without revealing secrets", () => {
  const entry = fileURLToPath(new URL("../src/server.js", import.meta.url));
  const result = spawnSync(process.execPath, [entry], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: secret,
      OPENAI_API_KEY: secret,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PORT must be an integer/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test("Provider contract supports typed async text, completion usage and prompt-token estimates", async () => {
  const adapter: Provider = {
    id: "test-only",
    async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
      yield { type: "text", delta: "hello" };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
    countTokens(req) {
      return req.messages.length;
    },
  };
  const request: ChatRequest = {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  };
  assert.equal(adapter.id, "test-only");
  assert.equal(adapter.countTokens(request), 1);
  const chunks: ChatChunk[] = [];
  for await (const chunk of adapter.chat(request)) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: "text", delta: "hello" },
    {
      type: "done",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1 },
    },
  ]);
});
