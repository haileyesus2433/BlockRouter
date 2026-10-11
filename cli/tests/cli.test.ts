import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { createProgramClient } from "../src/client.js";
import { loadProjectConfig, selectCluster } from "../src/config.js";
import { loadWallet, walletPath } from "../src/wallet.js";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const { version } = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
// Public RFC 8032 Ed25519 test vector #1, never a real or funded wallet.
const fixtureBytes = [
  ...Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" +
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ),
];
const expectedAddress = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
const programAddress = address("7maTNWbtCpuCXeRUVCNDR2a9YU7kaeUqtvrqz4ustyyi");

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "blockrouter-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wallet = join(dir, "wallet.json");
  const idl = join(dir, "idl.json");
  await writeFile(wallet, JSON.stringify(fixtureBytes));
  await writeFile(
    idl,
    JSON.stringify({
      address: programAddress,
      metadata: { name: "blockrouter", version: "0.1.0", spec: "0.1.0" },
      instructions: [],
    }),
  );
  return { dir, wallet, idl };
}

test("executable br --help works without wallet or IDL and from another directory", () => {
  const output = execFileSync(
    entry,
    ["--wallet", "/missing/wallet", "--idl", "/missing/idl", "--help"],
    { encoding: "utf8", cwd: tmpdir() },
  );
  assert.match(output, /Usage: br/);
  for (const option of [
    "--wallet",
    "--cluster",
    "--rpc-url",
    "--idl",
    "--version",
  ])
    assert.ok(output.includes(option));
});

test("br --version reports the package version", () => {
  assert.equal(
    execFileSync(entry, ["--version"], {
      encoding: "utf8",
      cwd: tmpdir(),
    }).trim(),
    version,
  );
});

test("wallet path defaults to Solana CLI location and expands tilde", () => {
  assert.equal(walletPath(), join(homedir(), ".config/solana/id.json"));
  assert.equal(walletPath("~/custom.json"), join(homedir(), "custom.json"));
  assert.equal(walletPath("wallet.json"), resolve("wallet.json"));
});

test("valid keypair derives the known public address and keeps private key nonextractable", async (t) => {
  const f = await fixture(t);
  const signer = await loadWallet(f.wallet);
  assert.equal(signer.address, expectedAddress);
  assert.equal(signer.keyPair.privateKey.extractable, false);
  const content = new TextEncoder().encode("BlockRouter offline signer test");
  const [signatures] = await signer.signMessages([{ content, signatures: {} }]);
  assert.equal(signatures[signer.address]?.length, 64);
  assert.equal(
    await crypto.subtle.verify(
      "Ed25519",
      signer.keyPair.publicKey,
      Uint8Array.from(signatures[signer.address]),
      content,
    ),
    true,
  );
  assert.equal(await readFile(f.wallet, "utf8"), JSON.stringify(fixtureBytes));
});

test("missing wallet gives an actionable error and creates no file", async (t) => {
  const f = await fixture(t);
  const path = join(f.dir, "absent.json");
  await assert.rejects(loadWallet(path), /Cannot read wallet.*--wallet/);
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

for (const [name, value] of [
  ["invalid JSON", "SECRET_SENTINEL {"],
  ["object", "{}"],
  ["short array", "[1,2,3]"],
  ["string bytes", JSON.stringify(Array(64).fill("1"))],
  ["negative bytes", JSON.stringify(Array(64).fill(-1))],
  ["oversized bytes", JSON.stringify(Array(64).fill(256))],
  ["fractional bytes", JSON.stringify(Array(64).fill(1.5))],
  ["inconsistent keypair", JSON.stringify(Array(64).fill(0))],
] as const) {
  test(`wallet rejects ${name} without revealing its contents`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.wallet, value);
    await assert.rejects(loadWallet(f.wallet), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Wallet (must contain|contains invalid)/);
      assert.ok(!error.message.includes("SECRET_SENTINEL"));
      assert.ok(!error.message.includes(value));
      return true;
    });
    assert.equal(await readFile(f.wallet, "utf8"), value);
  });
}

test("clusters resolve the expected endpoints and support an override", () => {
  assert.deepEqual(selectCluster("localnet"), {
    cluster: "localnet",
    endpoint: "http://127.0.0.1:8899",
  });
  assert.equal(
    selectCluster("devnet").endpoint,
    "https://api.devnet.solana.com",
  );
  assert.equal(
    selectCluster("mainnet-beta").endpoint,
    "https://api.mainnet-beta.solana.com",
  );
  assert.equal(
    selectCluster("devnet", "http://127.0.0.1:1234").endpoint,
    "http://127.0.0.1:1234",
  );
});

test("unsupported clusters and malformed RPC endpoints are rejected", () => {
  for (const cluster of ["testnet", "DEVNET", "toString", "", "__proto__"])
    assert.throws(() => selectCluster(cluster), /Unsupported cluster/);
  for (const endpoint of [
    "https:example.com",
    "localhost:8899",
    "not a URL",
    "file:///tmp/rpc",
    "ftp://example.com",
    "https://user:password@example.com",
    "https://example.com/#fragment",
  ])
    assert.throws(() => selectCluster("localnet", endpoint), /RPC URL/);
});

test("configuration reads provider defaults and the authoritative address from Anchor.toml", async () => {
  const config = await loadProjectConfig();
  assert.equal(config.cluster, "localnet");
  assert.equal(config.wallet, "~/.config/solana/id.json");
  assert.equal(config.programAddress, programAddress);
});

test("configuration rejects inconsistent program IDs", async (t) => {
  const f = await fixture(t);
  const config = join(f.dir, "Anchor.toml");
  await writeFile(
    config,
    '[provider]\ncluster="localnet"\nwallet="wallet.json"\n[programs.localnet]\nblockrouter="11111111111111111111111111111111"\n[programs.devnet]\nblockrouter="22222222222222222222222222222222"',
  );
  await assert.rejects(loadProjectConfig(config), /matching localnet\/devnet/);
});

test("program client initializes from IDL offline with the correct program and Kit signer", async (t) => {
  const f = await fixture(t);
  const wallet = await loadWallet(f.wallet);
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests++;
    throw new Error("Network forbidden");
  });
  const client = await createProgramClient({
    wallet,
    programAddress,
    endpoint: "http://127.0.0.1:1",
    idlPath: f.idl,
  });
  assert.equal(client.program.programId.toBase58(), programAddress);
  assert.equal(client.program.idl.address, programAddress);
  assert.equal(client.wallet, wallet);
  assert.ok(client.rpc);
  assert.equal(client.program.provider.sendAndConfirm, undefined);
  assert.equal(requests, 0);
});

test("program client rejects missing IDL and an address mismatch", async (t) => {
  const f = await fixture(t);
  const wallet = await loadWallet(f.wallet);
  const options = { wallet, programAddress, endpoint: "http://127.0.0.1:1" };
  await assert.rejects(
    createProgramClient({ ...options, idlPath: join(f.dir, "missing") }),
    /anchor build/,
  );
  await writeFile(
    f.idl,
    JSON.stringify({ address: "11111111111111111111111111111111" }),
  );
  await assert.rejects(
    createProgramClient({ ...options, idlPath: f.idl }),
    /does not match/,
  );
});

test("program client rejects invalid IDL structures and validates RPC independently", async (t) => {
  const f = await fixture(t);
  const wallet = await loadWallet(f.wallet);
  const options = {
    wallet,
    programAddress,
    endpoint: "http://127.0.0.1:1",
    idlPath: f.idl,
  };
  for (const value of [
    null,
    [],
    {},
    { address: programAddress, instructions: "invalid" },
  ]) {
    await writeFile(f.idl, JSON.stringify(value));
    await assert.rejects(
      createProgramClient(options),
      /invalid or unsupported Anchor IDL/,
    );
  }
  await assert.rejects(
    createProgramClient({ ...options, endpoint: "file:///tmp/rpc" }),
    /RPC URL/,
  );
});

test("CLI initializes offline, prints only public configuration, and rejects failures", async (t) => {
  const f = await fixture(t);
  const result = spawnSync(
    entry,
    [
      "--wallet",
      f.wallet,
      "--idl",
      f.idl,
      "--cluster",
      "devnet",
      "--rpc-url",
      "http://127.0.0.1:1/?api-key=SECRET_SENTINEL",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(expectedAddress));
  assert.match(result.stdout, /Cluster: devnet/);
  assert.match(result.stdout, /initialized offline/);
  assert.ok(!result.stdout.includes("SECRET_SENTINEL"));
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(JSON.stringify(fixtureBytes)));
  const bad = spawnSync(entry, ["--cluster", "testnet", "--wallet", f.wallet], {
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unsupported cluster/);
  const missing = spawnSync(entry, ["--wallet", join(f.dir, "missing")], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--wallet/);
  await writeFile(f.wallet, "SECRET_SENTINEL invalid JSON");
  const malformed = spawnSync(entry, ["--wallet", f.wallet], {
    encoding: "utf8",
  });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /JSON array/);
  assert.ok(!(malformed.stdout + malformed.stderr).includes("SECRET_SENTINEL"));
});
