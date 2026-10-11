import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FIXTURE_BYTES } from "./fixtures";

const BR = fileURLToPath(new URL("../bin/br.js", import.meta.url));

function br(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [BR, ...args], {
    encoding: "utf8",
    cwd: tmpdir(),
    env: { ...process.env, BR_KEYPAIR: "", ...env },
  });
}

test("--help works from any directory without a wallet", () => {
  const result = br(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const text of ["Usage: br", "--cluster", "--url", "--keypair", "wallet", "vault", "session"]) {
    assert.ok(result.stdout.includes(text), text);
  }
});

test("--version prints the package version", () => {
  const result = br(["--version"]);
  assert.equal(result.stdout.trim(), "0.1.0");
});

test("commands fail cleanly on a bad wallet without leaking its contents", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "br-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "wallet.json");
  await writeFile(path, "SECRET_SENTINEL not json");
  const result = br(["-k", path, "wallet"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JSON array/);
  assert.ok(!(result.stdout + result.stderr).includes("SECRET_SENTINEL"));
});

test("an RPC URL carrying credentials is never printed, even when the request fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "br-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "wallet.json");
  await writeFile(path, JSON.stringify(FIXTURE_BYTES));
  const result = br(["-k", path, "-u", "http://127.0.0.1:1/?api-key=SECRET_SENTINEL", "wallet"]);
  assert.equal(result.status, 1);
  assert.ok(!(result.stdout + result.stderr).includes("SECRET_SENTINEL"));
  assert.ok(!(result.stdout + result.stderr).includes(JSON.stringify(FIXTURE_BYTES)));
});

test("malformed RPC URLs and unknown clusters are rejected", () => {
  assert.match(br(["-u", "ftp://example.com", "wallet"]).stderr, /RPC URL|wallet/);
  const cluster = br(["-c", "testnet", "wallet"]);
  assert.equal(cluster.status, 1);
  assert.match(cluster.stderr, /testnet/);
});
