import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAmount } from "../src/amount";
import { formatUnits } from "../src/format";
import { describeRpc, validateRpcUrl } from "../src/rpc";

test("amounts convert whole tokens to base units exactly", () => {
  assert.equal(parseAmount("10", 6), 10_000_000n);
  assert.equal(parseAmount("2.5", 6), 2_500_000n);
  assert.equal(parseAmount("0.000001", 6), 1n);
  assert.equal(parseAmount(" 7 ", 0), 7n);
});

test("amounts reject zero, negatives, junk, and excess precision", () => {
  for (const input of ["0", "0.000000", "-1", "1e6", "abc", "1.2.3", "", "1.0000001"]) {
    assert.throws(() => parseAmount(input, 6), Error, input);
  }
});

test("formatting round-trips base units", () => {
  assert.equal(formatUnits(2_500_000n, 1_000_000n, 6), "2.5");
  assert.equal(formatUnits(10_000_000n, 1_000_000n, 6), "10");
  assert.equal(formatUnits(1n, 1_000_000n, 6), "0.000001");
  assert.equal(formatUnits(0n, 1_000_000n, 6), "0");
});

test("RPC URLs must be absolute HTTP(S) without credentials or fragments", () => {
  assert.equal(validateRpcUrl("http://127.0.0.1:8899"), "http://127.0.0.1:8899");
  assert.equal(validateRpcUrl("https://rpc.example.com/?api-key=x"), "https://rpc.example.com/?api-key=x");
  for (const url of [
    "https:example.com",
    "localhost:8899",
    "not a URL",
    "file:///tmp/rpc",
    "ftp://example.com",
    "https://user:password@example.com",
    "https://example.com/#fragment",
  ]) {
    assert.throws(() => validateRpcUrl(url), /RPC URL/, url);
  }
});

test("RPC descriptions never include paths or query strings that may hold API keys", () => {
  assert.equal(describeRpc("https://api.devnet.solana.com", false), "https://api.devnet.solana.com");
  const custom = describeRpc("https://rpc.example.com/v2/SECRET_KEY?api-key=SECRET_KEY", true);
  assert.equal(custom, "custom RPC at rpc.example.com");
});
