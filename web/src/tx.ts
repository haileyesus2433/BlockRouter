import type { Address, Instruction } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import {
  findVaultPda,
  getDepositInstructionAsync,
  getInitializeVaultInstructionAsync,
  getOpenSessionInstructionAsync,
  getReclaimExpiredSessionInstruction,
  getWithdrawInstructionAsync,
  withModelAccounts,
} from "@blockrouter/client";

import type { MintInfo, VaultView } from "./chain";
import type { Identity } from "./identity";

async function accounts(identity: Identity, mint: MintInfo) {
  const [vault] = await findVaultPda({ user: identity.address, mint: mint.address });
  const [userAta] = await findAssociatedTokenPda({
    owner: identity.address,
    mint: mint.address,
    tokenProgram: mint.tokenProgram,
  });
  return { vault, userAta };
}

/** Creates the vault on first use, then deposits, in one transaction. */
export async function deposit(identity: Identity, mint: MintInfo, vault: VaultView, amount: bigint): Promise<string> {
  const { vault: key, userAta } = await accounts(identity, mint);
  const user = identity.signer;
  const instructions: Instruction[] = [];
  if (!vault.exists) {
    instructions.push(await getInitializeVaultInstructionAsync({ user, mint: mint.address, tokenProgram: mint.tokenProgram }));
  }
  instructions.push(
    await getDepositInstructionAsync({ user, userAta, vault: key, mint: mint.address, tokenProgram: mint.tokenProgram, amount }),
  );
  return identity.send(instructions);
}

export async function withdraw(identity: Identity, mint: MintInfo, amount: bigint): Promise<string> {
  const { vault, userAta } = await accounts(identity, mint);
  const instruction = await getWithdrawInstructionAsync({
    user: identity.signer,
    userAta,
    vault,
    mint: mint.address,
    tokenProgram: mint.tokenProgram,
    amount,
  });
  return identity.send([instruction]);
}

export async function openSession(
  identity: Identity,
  vault: VaultView,
  options: { cap: bigint; durationSecs: number; modelIds: number[]; relayer: Address },
): Promise<string> {
  const instruction = await getOpenSessionInstructionAsync({
    user: identity.signer,
    vault: vault.key,
    sessionId: vault.sessionCounter,
    reservedAmount: options.cap,
    relayer: options.relayer,
    durationSecs: BigInt(options.durationSecs),
    modelIds: options.modelIds,
  });
  return identity.send([await withModelAccounts(instruction, options.modelIds)]);
}

export async function reclaim(identity: Identity, vault: VaultView, session: Address): Promise<string> {
  const instruction = getReclaimExpiredSessionInstruction({ user: identity.signer, vault: vault.key, session });
  return identity.send([instruction]);
}
