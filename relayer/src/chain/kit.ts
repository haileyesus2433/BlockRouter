import { type Address, createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { findAssociatedTokenPda } from "@solana-program/token";
import {
  blockrouterProgram,
  fetchConfig,
  fetchMaybeModel,
  fetchMaybeSession,
  fetchVault,
  findConfigPda,
  findModelPda,
  PayerKind,
} from "@blockrouter/client";

import type { Chain, ModelState, SessionState, SettleInput } from "./types";

export async function createKitChain(options: { rpcUrl: string; relayerKeypair: string }): Promise<Chain> {
  const client = await createClient()
    .use(signerFromFile(options.relayerKeypair))
    .use(solanaRpc({ rpcUrl: options.rpcUrl }))
    .use(blockrouterProgram());
  const { rpc } = client;

  async function getSession(address: Address): Promise<SessionState | null> {
    const account = await fetchMaybeSession(rpc, address);
    if (!account.exists) return null;
    const data = account.data;
    return {
      address,
      vault: data.payerAccount,
      payerKind: data.payerKind === PayerKind.Vault ? "vault" : "allowance",
      beneficiary: data.beneficiary,
      relayer: data.relayer,
      reservedAmount: data.reservedAmount,
      sessionId: data.sessionId,
      expiresAt: data.expiresAt,
      modelId: data.modelId,
    };
  }

  async function getModel(modelId: number): Promise<ModelState | null> {
    const [key] = await findModelPda({ modelId });
    const account = await fetchMaybeModel(rpc, key);
    if (!account.exists) return null;
    const { promptRate, completionRate, pendingPromptRate, pendingCompletionRate, effectiveAt, isActive } =
      account.data;
    return { modelId, promptRate, completionRate, pendingPromptRate, pendingCompletionRate, effectiveAt, isActive };
  }

  async function settle({ session, promptTokens, completionTokens }: SettleInput): Promise<string> {
    const vault = await fetchVault(rpc, session.vault);
    const config = await fetchConfig(rpc, (await findConfigPda())[0]);
    const mintAccount = await rpc.getAccountInfo(vault.data.mint, { encoding: "base64" }).send();
    if (!mintAccount.value) throw new Error(`mint ${vault.data.mint} not found`);
    const tokenProgram = mintAccount.value.owner;
    const [vaultAta] = await findAssociatedTokenPda({ owner: session.vault, mint: vault.data.mint, tokenProgram });
    const [providerAta] = await findAssociatedTokenPda({
      owner: config.data.provider,
      mint: vault.data.mint,
      tokenProgram,
    });
    const [model] = await findModelPda({ modelId: session.modelId });
    const result = await client.blockrouter.instructions
      .settleSessionUsage({
        relayer: client.payer,
        vault: session.vault,
        vaultAta,
        session: session.address,
        model,
        providerAta,
        tokenProgram,
        mint: vault.data.mint,
        beneficiary: session.beneficiary,
        promptTokens,
        completionTokens,
      })
      .sendTransaction();
    return String(result.context.signature);
  }

  async function now(): Promise<bigint> {
    const slot = await rpc.getSlot().send();
    const time = await rpc.getBlockTime(slot).send();
    return time === null ? BigInt(Math.floor(Date.now() / 1000)) : BigInt(time);
  }

  return { getSession, getModel, settle, now };
}
