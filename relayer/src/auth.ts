import { createHash, randomBytes } from "node:crypto";
import {
  type Address,
  address as toAddress,
  getBase58Encoder,
  getPublicKeyFromAddress,
  getUtf8Encoder,
  isAddress,
  type SignatureBytes,
  verifySignature,
} from "@solana/kit";

import { ApiError } from "./errors";
import type { ApiKeyRecord, Store } from "./store";

export const MAX_CLOCK_SKEW_SECS = 300;
const KEY_PREFIX = "brk_live_";

const unauthorized = (code: string, message: string) => new ApiError(401, "authentication_error", code, message);

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateKey(): { id: string; key: string } {
  return {
    id: `key_${randomBytes(8).toString("hex")}`,
    key: `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`,
  };
}

/** The exact message a wallet signs to call the key endpoints. */
export function walletAuthMessage(wallet: string, method: string, path: string, timestamp: number): string {
  return [
    "BlockRouter API request",
    `Address: ${wallet}`,
    `Method: ${method.toUpperCase()}`,
    `Path: ${path}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}

// Sign-In With Solana style: the wallet signs method, path, and a fresh timestamp.
export async function verifyWalletRequest(
  headers: { address?: string; signature?: string; timestamp?: string },
  method: string,
  path: string,
  nowSecs: number,
): Promise<Address> {
  const { address, signature, timestamp } = headers;
  if (!address || !signature || !timestamp) {
    throw unauthorized(
      "wallet_auth_required",
      "sign the request with your wallet: send X-BlockRouter-Address, X-BlockRouter-Timestamp, and X-BlockRouter-Signature",
    );
  }
  if (!isAddress(address)) throw unauthorized("wallet_auth_invalid", "X-BlockRouter-Address is not a valid address");
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSecs - ts) > MAX_CLOCK_SKEW_SECS) {
    throw unauthorized("wallet_auth_expired", `timestamp must be within ${MAX_CLOCK_SKEW_SECS}s of server time`);
  }
  let signatureBytes: SignatureBytes;
  try {
    signatureBytes = getBase58Encoder().encode(signature) as SignatureBytes;
  } catch {
    throw unauthorized("wallet_auth_invalid", "X-BlockRouter-Signature is not base58");
  }
  const wallet = toAddress(address);
  const message = getUtf8Encoder().encode(walletAuthMessage(wallet, method, path, ts));
  const publicKey = await getPublicKeyFromAddress(wallet);
  if (signatureBytes.length !== 64 || !(await verifySignature(publicKey, signatureBytes, message))) {
    throw unauthorized("wallet_auth_invalid", "wallet signature does not match the request");
  }
  return wallet;
}

export function verifyApiKey(store: Store, authorization: string | undefined): ApiKeyRecord {
  const key = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!key.startsWith(KEY_PREFIX)) {
    throw unauthorized(
      "invalid_api_key",
      "missing or malformed API key. Create one with `br key create --name <name>` and send it as `Authorization: Bearer brk_live_...`",
    );
  }
  const record = store.findKeyByHash(hashKey(key));
  if (!record) {
    throw unauthorized("invalid_api_key", "unknown API key. Create one with `br key create --name <name>`");
  }
  if (record.revokedAt !== null) {
    throw unauthorized("key_revoked", "this API key was revoked. Create a new one with `br key create`");
  }
  return record;
}
