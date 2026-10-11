import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BN, Program, web3, type Idl } from "@anchor-lang/core";
import { createApp } from "../src/app.js";
import { createModelRegistry } from "../src/models.js";

// Actual Rust Model layout, including its Anchor discriminator. No named registry exists.
const idl: Idl = {
  address: "7maTNWbtCpuCXeRUVCNDR2a9YU7kaeUqtvrqz4ustyyi",
  metadata: { name: "blockrouter", version: "0.1.0", spec: "0.1.0" },
  instructions: [],
  accounts: [
    { name: "Model", discriminator: [152, 221, 247, 122, 185, 125, 223, 151] },
  ],
  types: [
    {
      name: "Model",
      type: {
        kind: "struct",
        fields: [
          { name: "model_id", type: "u16" },
          { name: "prompt_rate", type: "u64" },
          { name: "completion_rate", type: "u64" },
          { name: "pending_prompt_rate", type: "u64" },
          { name: "pending_completion_rate", type: "u64" },
          { name: "effective_at", type: "i64" },
          { name: "is_active", type: "bool" },
          { name: "bump", type: "u8" },
        ],
      },
    },
  ],
};

async function fixture(t: TestContext, ids = [7, 2], now = 99n) {
  const connection = new web3.Connection("http://127.0.0.1:1");
  const program = new Program(idl, { connection });
  const accounts = await Promise.all(
    ids.map(async (modelId) => {
      const seed = Buffer.alloc(2);
      seed.writeUInt16LE(modelId);
      const [pubkey, bump] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("model"), seed],
        program.programId,
      );
      return {
        pubkey,
        account: {
          owner: program.programId,
          executable: false,
          lamports: 1,
          rentEpoch: 0,
          data: await program.coder.accounts.encode("model", {
            modelId,
            bump,
            isActive: modelId !== 7,
            promptRate: new BN("18446744073709551615"),
            completionRate: new BN(1100),
            pendingPromptRate: new BN(0),
            pendingCompletionRate: new BN(2200),
            effectiveAt: new BN(100),
          }),
        },
      };
    }),
  );
  const clock = {
    owner: new web3.PublicKey("Sysvar1111111111111111111111111111111111111"),
    executable: false,
    lamports: 1,
    rentEpoch: 0,
    data: Buffer.alloc(40),
  };
  clock.data.writeBigInt64LE(now, 32);
  const discovery = t.mock.method(
    connection,
    "getProgramAccounts",
    async (_id: web3.PublicKey, config: unknown) => {
      assert.ok(_id.equals(program.programId));
      assert.deepEqual(config, {
        commitment: "confirmed",
        withContext: true,
        dataSlice: { offset: 0, length: 0 },
        filters: [{ memcmp: { offset: 0, bytes: "Sa17YpUXhin" } }],
      });
      return { context: { slot: 123 }, value: accounts };
    },
  );
  const reads = t.mock.method(
    connection,
    "getMultipleAccountsInfoAndContext",
    async (keys: web3.PublicKey[], config: unknown) => {
      assert.deepEqual(config, {
        commitment: "confirmed",
        minContextSlot: 123,
      });
      assert.ok(keys.at(-1)?.equals(web3.SYSVAR_CLOCK_PUBKEY));
      assert.ok(keys.length <= 100);
      return {
        context: { slot: 123 },
        value: [
          ...keys
            .slice(0, -1)
            .map(
              (key) =>
                accounts.find((a) => a.pubkey.equals(key))?.account ?? null,
            ),
          clock,
        ],
      };
    },
  );
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network");
  });
  return {
    program,
    accounts,
    clock,
    discovery,
    reads,
    app: createApp(createModelRegistry(program)),
  };
}

test("lists decoded on-chain Models sorted by numeric ID with lossless pricing", async (t) => {
  const f = await fixture(t);
  const response = await f.app.request("/v1/models");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    object: "list",
    data: [2, 7].map((id) => ({
      id: String(id),
      object: "model",
      owned_by: "blockrouter",
      blockrouter: {
        model_id: id,
        prompt_rate: "18446744073709551615",
        completion_rate: "1100",
        active: id !== 7,
      },
    })),
  });
  assert.equal(f.discovery.mock.callCount(), 1);
  assert.equal(f.reads.mock.callCount(), 1);
});

for (const [now, prompt, completion] of [
  [99n, "18446744073709551615", "1100"],
  [100n, "0", "2200"],
  [101n, "0", "2200"],
] as const) {
  test(`timelocked prices use chain Clock at ${now}`, async (t) => {
    const f = await fixture(t, [3], now);
    const response = await f.app.request("/v1/models");
    assert.equal(response.status, 200);
    const data = (await response.json()).data[0].blockrouter;
    assert.equal(data.prompt_rate, prompt);
    assert.equal(data.completion_rate, completion);
  });
}

test("zero effective_at ignores pending rates and each request reads live accounts", async (t) => {
  const f = await fixture(t, [11], 1000n);
  f.accounts[0].account.data.writeBigInt64LE(0n, 42);
  let response = await f.app.request("/v1/models");
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).data[0].blockrouter.prompt_rate,
    "18446744073709551615",
  );
  f.accounts[0].account.data.writeBigUInt64LE(123456789n, 10);
  response = await f.app.request("/v1/models");
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).data[0].blockrouter.prompt_rate,
    "123456789",
  );
  assert.equal(f.discovery.mock.callCount(), 2);
});

test("empty registry needs no Clock request", async (t) => {
  const f = await fixture(t, []);
  const response = await f.app.request("/v1/models");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { object: "list", data: [] });
  assert.equal(f.reads.mock.callCount(), 0);
});

test("more than 99 Models are fetched in bounded batches with Clock", async (t) => {
  const f = await fixture(
    t,
    Array.from({ length: 100 }, (_, i) => i),
  );
  const response = await f.app.request("/v1/models");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.length, 100);
  assert.equal(f.reads.mock.callCount(), 2);
});

for (const failure of [
  "discovery",
  "batch",
  "owner",
  "pda",
  "bump",
  "discriminator",
  "truncated",
  "clock",
  "missing",
  "duplicate",
] as const) {
  test(`registry ${failure} failure is sanitized and fails the whole response`, async (t) => {
    const f = await fixture(t, [3]);
    const secret = "SECRET_RPC_CREDENTIAL";
    if (failure === "discovery")
      f.discovery.mock.mockImplementation(async () => {
        throw new Error(secret);
      });
    if (failure === "batch")
      f.reads.mock.mockImplementation(async () => {
        throw new Error(secret);
      });
    if (failure === "owner")
      f.accounts[0].account.owner = web3.SystemProgram.programId;
    if (failure === "pda") f.accounts[0].pubkey = web3.SystemProgram.programId;
    if (failure === "bump") f.accounts[0].account.data[51] ^= 1;
    if (failure === "discriminator") f.accounts[0].account.data[0] ^= 1;
    if (failure === "truncated") f.accounts[0].account.data = Buffer.alloc(8);
    if (failure === "clock") f.clock.data = Buffer.alloc(0);
    if (failure === "missing")
      f.reads.mock.mockImplementation(async () => ({
        context: { slot: 123 },
        value: [null, f.clock],
      }));
    if (failure === "duplicate") f.accounts.push(f.accounts[0]);
    const logs: unknown[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
    const response = await f.app.request("/v1/models");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Model registry unavailable",
    });
    assert.deepEqual(logs, []);
  });
}

test("unconfigured registry fails closed and Session lookup remains unavailable", async () => {
  const app = createApp();
  assert.equal((await app.request("/v1/models")).status, 503);
  const response = await app.request(
    "/v1/session/current?owner=anyone&session=anything",
    { headers: { authorization: "Bearer unverified" } },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});
