import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { loadWallet, walletPath } from "../src/wallet";
import { FIXTURE_ADDRESS, FIXTURE_BYTES } from "./fixtures";

async function tempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "br-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("wallet path defaults to the Solana CLI location, honours BR_KEYPAIR, and expands ~", () => {
  const saved = process.env.BR_KEYPAIR;
  delete process.env.BR_KEYPAIR;
  try {
    assert.equal(walletPath(), join(homedir(), ".config/solana/id.json"));
    process.env.BR_KEYPAIR = "~/from-env.json";
    assert.equal(walletPath(), join(homedir(), "from-env.json"));
    assert.equal(walletPath("~/custom.json"), join(homedir(), "custom.json"));
    assert.equal(walletPath("wallet.json"), resolve("wallet.json"));
  } finally {
    if (saved === undefined) delete process.env.BR_KEYPAIR;
    else process.env.BR_KEYPAIR = saved;
  }
});

test("valid keypair derives the known address, signs, and keeps the private key non-extractable", async (t) => {
  const path = join(await tempDir(t), "wallet.json");
  await writeFile(path, JSON.stringify(FIXTURE_BYTES));
  const signer = await loadWallet(path);
  assert.equal(signer.address, FIXTURE_ADDRESS);
  assert.equal(signer.keyPair.privateKey.extractable, false);
  const content = new TextEncoder().encode("BlockRouter signer test");
  const [signatures] = await signer.signMessages([{ content, signatures: {} }]);
  const signature = signatures[signer.address]!;
  assert.equal(signature.length, 64);
  assert.ok(await crypto.subtle.verify("Ed25519", signer.keyPair.publicKey, Uint8Array.from(signature), content));
  assert.equal(await readFile(path, "utf8"), JSON.stringify(FIXTURE_BYTES), "wallet file must not change");
});

test("a missing wallet gives an actionable error and creates no file", async (t) => {
  const path = join(await tempDir(t), "absent.json");
  await assert.rejects(loadWallet(path), /cannot read wallet.*--keypair/);
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
    const path = join(await tempDir(t), "wallet.json");
    await writeFile(path, value);
    await assert.rejects(loadWallet(path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /wallet (must contain|contains invalid)/);
      assert.ok(!error.message.includes("SECRET_SENTINEL"));
      assert.ok(!error.message.includes(value));
      return true;
    });
    assert.equal(await readFile(path, "utf8"), value);
  });
}
