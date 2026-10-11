import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createKeyPairSignerFromBytes } from "@solana/kit";

export function walletPath(path = "~/.config/solana/id.json"): string {
  return resolve(
    path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path,
  );
}

/** Load an existing Solana CLI keypair; never generate, write or log key material. */
export async function loadWallet(path?: string) {
  const filename = walletPath(path);
  let text: string;
  try {
    text = await readFile(filename, "utf8");
  } catch {
    throw new Error(
      `Cannot read wallet ${filename}. Select an existing keypair with --wallet.`,
    );
  }
  let bytes: unknown;
  try {
    bytes = JSON.parse(text);
  } catch {
    // JSON parser messages can include private key material.
    throw new Error("Wallet must contain a JSON array of 64 secret-key bytes.");
  }
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    throw new Error(
      "Wallet must contain a JSON array of 64 integer bytes (0–255).",
    );
  }
  const secret = Uint8Array.from(bytes);
  try {
    // Kit verifies that the public half matches the private half before returning.
    return await createKeyPairSignerFromBytes(secret);
  } catch {
    throw new Error(
      "Wallet contains invalid or inconsistent keypair material.",
    );
  } finally {
    secret.fill(0);
    bytes.fill(0);
  }
}
