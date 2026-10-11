import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";

const DEFAULT_WALLET = "~/.config/solana/id.json";
const SECRET_KEY_LENGTH = 64;

export function walletPath(path?: string): string {
  const raw = path ?? process.env.BR_KEYPAIR ?? DEFAULT_WALLET;
  return resolve(raw.startsWith("~/") ? `${homedir()}/${raw.slice(2)}` : raw);
}

/** Loads an existing Solana CLI keypair. Never generates, writes, or logs key material. */
export async function loadWallet(path?: string): Promise<KeyPairSigner> {
  const filename = walletPath(path);
  let text: string;
  try {
    text = await readFile(filename, "utf8");
  } catch {
    throw new Error(`cannot read wallet ${filename}. Pass --keypair <path> or set BR_KEYPAIR.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Parser messages can quote the file, which is secret key material.
    throw new Error("wallet must contain a JSON array of 64 secret-key bytes");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== SECRET_KEY_LENGTH ||
    !parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    throw new Error("wallet must contain a JSON array of 64 integer bytes (0-255)");
  }
  const secret = Uint8Array.from(parsed as number[]);
  try {
    // Kit checks that the public half matches the private half.
    return await createKeyPairSignerFromBytes(secret);
  } catch {
    throw new Error("wallet contains invalid or inconsistent keypair material");
  } finally {
    secret.fill(0);
    (parsed as number[]).fill(0);
  }
}
