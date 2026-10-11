import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getBase58Encoder, getPublicKeyFromAddress, type SignatureBytes, verifySignature } from "@solana/kit";
import { WALLET_AUTH_HEADERS, walletAuthMessage } from "@blockrouter/client";

import { relayerUrl, signedHeaders } from "../src/relayer";
import { loadWallet } from "../src/wallet";
import { FIXTURE_ADDRESS, FIXTURE_BYTES } from "./fixtures";

async function fixtureSigner(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "br-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "wallet.json");
  await writeFile(path, JSON.stringify(FIXTURE_BYTES));
  return loadWallet(path);
}

test("signed headers verify against the shared relayer auth message", async (t) => {
  const signer = await fixtureSigner(t);
  const headers = await signedHeaders(signer, "post", "/v1/keys", 1_800_000_000);
  assert.equal(headers[WALLET_AUTH_HEADERS.address], FIXTURE_ADDRESS);
  assert.equal(headers[WALLET_AUTH_HEADERS.timestamp], "1800000000");

  const signature = getBase58Encoder().encode(headers[WALLET_AUTH_HEADERS.signature]!) as SignatureBytes;
  const key = await getPublicKeyFromAddress(signer.address);
  const signed = new TextEncoder().encode(walletAuthMessage(FIXTURE_ADDRESS, "POST", "/v1/keys", 1_800_000_000));
  assert.ok(await verifySignature(key, signature, signed));

  const otherPath = new TextEncoder().encode(walletAuthMessage(FIXTURE_ADDRESS, "POST", "/v1/keys/x", 1_800_000_000));
  assert.ok(!(await verifySignature(key, signature, otherPath)), "a signature must not cover another path");
});

test("relayer URL resolution prefers the flag, then env, then deployment, then localhost", () => {
  const saved = process.env.BR_RELAYER_URL;
  delete process.env.BR_RELAYER_URL;
  try {
    assert.equal(relayerUrl(undefined, null), "http://127.0.0.1:8787");
    assert.equal(relayerUrl(undefined, "https://relay.example.com/"), "https://relay.example.com");
    process.env.BR_RELAYER_URL = "http://localhost:9000";
    assert.equal(relayerUrl(undefined, "https://relay.example.com"), "http://localhost:9000");
    assert.equal(relayerUrl("https://flag.example.com", "https://relay.example.com"), "https://flag.example.com");
  } finally {
    if (saved === undefined) delete process.env.BR_RELAYER_URL;
    else process.env.BR_RELAYER_URL = saved;
  }
});

test("relayer URLs must be HTTP(S) without credentials", () => {
  for (const url of ["ftp://relay", "relay.example.com", "https://u:p@relay.example.com", "https://relay.example.com/#x"]) {
    assert.throws(() => relayerUrl(url, null), /relayer URL/, url);
  }
});
