import { address, type Address, getBase58Decoder, getBase64Encoder, type Base58EncodedBytes } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import {
  BLOCKROUTER_PROGRAM_ADDRESS,
  fetchMaybeVault,
  findVaultPda,
  getSessionDecoder,
  SESSION_DISCRIMINATOR,
  type Session,
} from "@blockrouter/client";

import { cluster } from "./config";
import { rpc } from "./identity";

export type MintInfo = { address: Address; label: string; decimals: number; tokenProgram: Address };

const DECIMALS_OFFSET = 44;
const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32;

export async function readChainTime(): Promise<number> {
  const { value } = await rpc.getAccountInfo(CLOCK_SYSVAR, { encoding: "base64" }).send();
  if (!value) throw new Error("Clock sysvar not found");
  const data = getBase64Encoder().encode(value.data[0]);
  return Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(CLOCK_UNIX_TIMESTAMP_OFFSET, true));
}

export async function loadMint(mint: Address, label: string): Promise<MintInfo> {
  const { value } = await rpc.getAccountInfo(mint, { encoding: "base64" }).send();
  if (!value) throw new Error(`Token mint ${mint} was not found on ${cluster}.`);
  const data = getBase64Encoder().encode(value.data[0]);
  return { address: mint, label, decimals: data[DECIMALS_OFFSET]!, tokenProgram: value.owner };
}

export type VaultView = {
  key: Address;
  exists: boolean;
  balance: bigint;
  reserved: bigint;
  sessionCounter: bigint;
  wallet: bigint;
  sol: bigint;
};

export async function readVault(owner: Address, mint: MintInfo): Promise<VaultView> {
  const [key] = await findVaultPda({ user: owner, mint: mint.address });
  const [ata] = await findAssociatedTokenPda({ owner, mint: mint.address, tokenProgram: mint.tokenProgram });
  const [vault, tokenAccount, sol] = await Promise.all([
    fetchMaybeVault(rpc, key),
    rpc.getAccountInfo(ata, { encoding: "base64" }).send(),
    rpc.getBalance(owner).send(),
  ]);
  const wallet = tokenAccount.value ? BigInt((await rpc.getTokenAccountBalance(ata).send()).value.amount) : 0n;
  return {
    key,
    exists: vault.exists,
    balance: vault.exists ? vault.data.balance : 0n,
    reserved: vault.exists ? vault.data.totalReserved : 0n,
    sessionCounter: vault.exists ? vault.data.sessionCounter : 0n,
    wallet,
    sol: sol.value,
  };
}

export type SessionView = { address: Address; data: Session };

export async function listSessions(vault: Address): Promise<SessionView[]> {
  const discriminator = getBase58Decoder().decode(SESSION_DISCRIMINATOR) as Base58EncodedBytes;
  const accounts = await rpc
    .getProgramAccounts(BLOCKROUTER_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [
        { memcmp: { offset: 0n, bytes: discriminator, encoding: "base58" } },
        { memcmp: { offset: 8n, bytes: vault as unknown as Base58EncodedBytes, encoding: "base58" } },
      ],
    })
    .send();
  const decoder = getSessionDecoder();
  return accounts
    .map(({ pubkey, account }) => ({ address: pubkey, data: decoder.decode(getBase64Encoder().encode(account.data[0])) }))
    .sort((a, b) => Number(b.data.sessionId - a.data.sessionId));
}
