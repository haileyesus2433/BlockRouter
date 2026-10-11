import { address, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import type { Context } from "./context";

const TOKEN_2022_PROGRAM_ADDRESS = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
// Base mint layout: mint_authority COption<Pubkey> (36) + supply u64 (8), then decimals.
const DECIMALS_OFFSET = 44;

export type MintInfo = {
  address: Address;
  label: string;
  decimals: number;
  tokenProgram: Address;
};

export function resolveMintAddress(ctx: Context, mint: string): { address: Address; label: string } {
  const { deployment } = ctx;
  if (mint === "usdc") {
    return { address: deployment.usdcMint, label: "USDC" };
  }
  if (mint === "usdt") {
    if (!deployment.mockUsdtMint) {
      throw new Error(`no mock USDT mint recorded for ${deployment.cluster}. Run the seed script.`);
    }
    return { address: deployment.mockUsdtMint, label: "USDT" };
  }
  return { address: address(mint), label: mint };
}

export async function loadMint(ctx: Context, mint: string): Promise<MintInfo> {
  const { address: mintAddress, label } = resolveMintAddress(ctx, mint);
  const { value } = await ctx.client.rpc
    .getAccountInfo(mintAddress, { encoding: "base64" })
    .send();
  if (!value) {
    throw new Error(`mint ${mintAddress} not found on ${ctx.deployment.cluster}`);
  }
  if (value.owner !== TOKEN_PROGRAM_ADDRESS && value.owner !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new Error(`${mintAddress} is not a token mint (owner ${value.owner})`);
  }
  const data = Buffer.from(value.data[0], "base64");
  if (data.length < DECIMALS_OFFSET + 1) {
    throw new Error(`${mintAddress} has an invalid mint layout`);
  }
  return {
    address: mintAddress,
    label,
    decimals: data[DECIMALS_OFFSET],
    tokenProgram: value.owner,
  };
}
