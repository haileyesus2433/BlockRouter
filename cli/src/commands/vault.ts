import type { Command } from "commander";
import type { Address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { fetchMaybeVault, findVaultPda } from "@blockrouter/client";

import { parseAmount } from "../amount";
import { type Context, createContext, type GlobalOptions } from "../context";
import { formatUnits } from "../format";
import { loadMint, type MintInfo } from "../mint";

type MintOption = { mint: string };

async function setup(program: Command, mintName: string) {
  const ctx = await createContext(program.opts<GlobalOptions>());
  const mint = await loadMint(ctx, mintName);
  const owner = ctx.client.payer.address;
  const [vault] = await findVaultPda({ user: owner, mint: mint.address });
  const [userAta] = await findAssociatedTokenPda({
    owner,
    mint: mint.address,
    tokenProgram: mint.tokenProgram,
  });
  return { ctx, mint, owner, vault, userAta };
}

async function tokenBalance(ctx: Context, ata: Address): Promise<bigint> {
  const { value } = await ctx.client.rpc.getAccountInfo(ata, { encoding: "base64" }).send();
  if (!value) {
    return 0n;
  }
  const { value: balance } = await ctx.client.rpc.getTokenAccountBalance(ata).send();
  return BigInt(balance.amount);
}

function show(amount: bigint, mint: MintInfo): string {
  return `${formatUnits(amount, 10n ** BigInt(mint.decimals), mint.decimals)} ${mint.label}`;
}

async function requireVault(ctx: Context, vault: Address) {
  const account = await fetchMaybeVault(ctx.client.rpc, vault);
  if (!account.exists) {
    throw new Error("no vault for this wallet and mint. Run `br vault init` first.");
  }
  return account.data;
}

export function registerVaultCommands(program: Command) {
  const vault = program.command("vault").description("manage your self-custodial vault");
  const mintOption = ["-m, --mint <mint>", "usdt, usdc, or a mint address", "usdt"] as const;

  vault
    .command("init")
    .description("create your vault for a mint")
    .option(...mintOption)
    .action(async ({ mint: mintName }: MintOption) => {
      const { ctx, mint, vault: key } = await setup(program, mintName);
      if ((await fetchMaybeVault(ctx.client.rpc, key)).exists) {
        console.log(`vault already exists: ${key}`);
        return;
      }
      await ctx.client.blockrouter.instructions
        .initializeVault({ user: ctx.client.payer, mint: mint.address, tokenProgram: mint.tokenProgram })
        .sendTransaction();
      console.log(`vault created: ${key} (${mint.label})`);
    });

  vault
    .command("deposit")
    .description("move tokens from your wallet into your vault")
    .argument("<amount>", "amount in whole tokens, e.g. 10 or 2.5")
    .option(...mintOption)
    .action(async (amountInput: string, { mint: mintName }: MintOption) => {
      const { ctx, mint, vault: key, userAta } = await setup(program, mintName);
      const amount = parseAmount(amountInput, mint.decimals);
      await requireVault(ctx, key);
      const walletBalance = await tokenBalance(ctx, userAta);
      if (walletBalance < amount) {
        throw new Error(`wallet holds ${show(walletBalance, mint)}, cannot deposit ${show(amount, mint)}`);
      }
      await ctx.client.blockrouter.instructions
        .deposit({
          user: ctx.client.payer,
          userAta,
          vault: key,
          mint: mint.address,
          tokenProgram: mint.tokenProgram,
          amount,
        })
        .sendTransaction();
      const state = await requireVault(ctx, key);
      console.log(`deposited ${show(amount, mint)}. vault balance: ${show(state.balance, mint)}`);
    });

  vault
    .command("withdraw")
    .description("move unreserved tokens from your vault back to your wallet")
    .argument("<amount>", 'amount in whole tokens, or "all" for everything unreserved')
    .option(...mintOption)
    .action(async (amountInput: string, { mint: mintName }: MintOption) => {
      const { ctx, mint, vault: key, userAta } = await setup(program, mintName);
      const state = await requireVault(ctx, key);
      const available = state.balance - state.totalReserved;
      const amount = amountInput === "all" ? available : parseAmount(amountInput, mint.decimals);
      if (amount === 0n) {
        throw new Error("nothing to withdraw: all funds are reserved by open sessions");
      }
      if (amount > available) {
        throw new Error(
          `only ${show(available, mint)} is available; ${show(state.totalReserved, mint)} is reserved by open sessions`,
        );
      }
      await ctx.client.blockrouter.instructions
        .withdraw({
          user: ctx.client.payer,
          userAta,
          vault: key,
          mint: mint.address,
          tokenProgram: mint.tokenProgram,
          amount,
        })
        .sendTransaction();
      const after = await requireVault(ctx, key);
      console.log(`withdrew ${show(amount, mint)}. vault balance: ${show(after.balance, mint)}`);
    });

  vault
    .command("status")
    .description("show balance, reserved, and available funds")
    .option(...mintOption)
    .action(async ({ mint: mintName }: MintOption) => {
      const { ctx, mint, owner, vault: key, userAta } = await setup(program, mintName);
      const account = await fetchMaybeVault(ctx.client.rpc, key);
      const walletBalance = await tokenBalance(ctx, userAta);
      console.log(`owner:     ${owner}`);
      console.log(`mint:      ${mint.address} (${mint.label})`);
      console.log(`wallet:    ${show(walletBalance, mint)}`);
      if (!account.exists) {
        console.log("vault:     none. Run `br vault init` to create one.");
        return;
      }
      const { balance, totalReserved, sessionCounter } = account.data;
      console.log(`vault:     ${key}`);
      console.log(`balance:   ${show(balance, mint)}`);
      console.log(`reserved:  ${show(totalReserved, mint)}`);
      console.log(`available: ${show(balance - totalReserved, mint)}`);
      console.log(`sessions:  ${sessionCounter} opened`);
    });
}
