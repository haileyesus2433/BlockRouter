import type { Command } from "commander";
import { type Address, address, getBase64Encoder } from "@solana/kit";
import {
  BLOCKROUTER_PROGRAM_ADDRESS,
  fetchMaybeModel,
  fetchMaybeVault,
  findModelPda,
  findSessionPda,
  findVaultPda,
  getSessionDecoder,
  getSessionSize,
  type Session,
} from "@blockrouter/client";

import { parseAmount } from "../amount";
import { type Context, createContext, type GlobalOptions } from "../context";
import { formatUnits } from "../format";
import { loadMint, type MintInfo } from "../mint";

const MIN_SESSION_SECS = 60;
const MAX_SESSION_SECS = 7 * 24 * 60 * 60;
// Session layout: 8-byte discriminator, then payer_account.
const PAYER_ACCOUNT_OFFSET = 8n;

type OpenOptions = {
  cap: string;
  hours?: string;
  minutes?: string;
  model: string;
  relayer?: string;
  mint: string;
};

async function setup(program: Command, mintName: string) {
  const ctx = await createContext(program.opts<GlobalOptions>());
  const mint = await loadMint(ctx, mintName);
  const [vault] = await findVaultPda({ user: ctx.client.payer.address, mint: mint.address });
  const account = await fetchMaybeVault(ctx.client.rpc, vault);
  if (!account.exists) {
    throw new Error("no vault for this wallet and mint. Run `br vault init` first.");
  }
  return { ctx, mint, vault, state: account.data };
}

function show(amount: bigint, mint: MintInfo): string {
  return `${formatUnits(amount, 10n ** BigInt(mint.decimals), mint.decimals)} ${mint.label}`;
}

function parseDuration(options: OpenOptions): number {
  if (options.hours && options.minutes) {
    throw new Error("pass either --hours or --minutes, not both");
  }
  const value = Number(options.hours ?? options.minutes ?? "24");
  const secs = Math.round(value * (options.minutes ? 60 : 3_600));
  if (!Number.isFinite(secs) || secs < MIN_SESSION_SECS || secs > MAX_SESSION_SECS) {
    throw new Error("session duration must be between 1 minute and 7 days");
  }
  return secs;
}

function resolveModel(ctx: Context, input: string) {
  const model = ctx.deployment.models.find(
    (entry) => entry.alias === input || String(entry.id) === input,
  );
  if (!model) {
    const known = ctx.deployment.models.map((entry) => `${entry.alias} (${entry.id})`).join(", ");
    throw new Error(`unknown model "${input}". Known models: ${known}`);
  }
  return model;
}

function resolveRelayer(ctx: Context, input: string | undefined): Address {
  const relayer = input ?? ctx.deployment.relayer;
  if (!relayer) {
    throw new Error(`no relayer configured for ${ctx.deployment.cluster}. Pass --relayer <address>.`);
  }
  return address(relayer);
}

async function listSessions(ctx: Context, vault: Address): Promise<{ address: Address; data: Session }[]> {
  const accounts = await ctx.client.rpc
    .getProgramAccounts(BLOCKROUTER_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [
        { dataSize: BigInt(getSessionSize()) },
        { memcmp: { offset: PAYER_ACCOUNT_OFFSET, bytes: vault, encoding: "base58" } },
      ],
    })
    .send();
  const decoder = getSessionDecoder();
  const base64 = getBase64Encoder();
  return accounts
    .map(({ pubkey, account }) => ({
      address: pubkey,
      data: decoder.decode(base64.encode(account.data[0])),
    }))
    .sort((a, b) => Number(a.data.sessionId - b.data.sessionId));
}

function nowSecs(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function describeExpiry(expiresAt: bigint): string {
  const remaining = Number(expiresAt - nowSecs());
  const when = new Date(Number(expiresAt) * 1000).toISOString();
  if (remaining <= 0) {
    return `expired ${when}`;
  }
  const hours = Math.floor(remaining / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  return `expires ${when} (in ${hours}h ${minutes}m)`;
}

export function registerSessionCommands(program: Command) {
  const session = program.command("session").description("open and manage capped spending sessions");
  const mintOption = ["-m, --mint <mint>", "usdt, usdc, or a mint address", "usdt"] as const;

  session
    .command("open")
    .description("reserve part of your vault for a relayer to bill one model")
    .requiredOption("--cap <amount>", "maximum the relayer can charge, e.g. 5")
    .requiredOption("--model <model>", "model alias or id the session may be billed for")
    .option("--hours <hours>", "session length in hours (default 24)")
    .option("--minutes <minutes>", "session length in minutes")
    .option("--relayer <address>", "relayer allowed to settle (default: deployment relayer)")
    .option(...mintOption)
    .action(async (options: OpenOptions) => {
      const { ctx, mint, vault, state } = await setup(program, options.mint);
      const cap = parseAmount(options.cap, mint.decimals);
      const durationSecs = parseDuration(options);
      const model = resolveModel(ctx, options.model);
      const relayer = resolveRelayer(ctx, options.relayer);

      const available = state.balance - state.totalReserved;
      if (cap > available) {
        throw new Error(`only ${show(available, mint)} is available to reserve. Deposit more with \`br vault deposit\`.`);
      }
      const [modelKey] = await findModelPda({ modelId: model.id });
      const modelAccount = await fetchMaybeModel(ctx.client.rpc, modelKey);
      if (!modelAccount.exists || !modelAccount.data.isActive) {
        throw new Error(`model ${model.alias} is not registered or not active on ${ctx.deployment.cluster}`);
      }

      const sessionId = state.sessionCounter;
      const [sessionKey] = await findSessionPda({ vault, sessionId });
      await ctx.client.blockrouter.instructions
        .openSession({
          user: ctx.client.payer,
          vault,
          model: modelKey,
          sessionId,
          reservedAmount: cap,
          relayer,
          durationSecs: BigInt(durationSecs),
        })
        .sendTransaction();

      console.log(`session opened: ${sessionKey}`);
      console.log(`id:       ${sessionId}`);
      console.log(`model:    ${model.alias} (${model.id})`);
      console.log(`cap:      ${show(cap, mint)}`);
      console.log(`relayer:  ${relayer}`);
      console.log(`expiry:   ${describeExpiry(nowSecs() + BigInt(durationSecs))}`);
    });

  session
    .command("status")
    .description("list open sessions on your vault")
    .option(...mintOption)
    .action(async ({ mint: mintName }: { mint: string }) => {
      const { ctx, mint, vault, state } = await setup(program, mintName);
      const sessions = await listSessions(ctx, vault);
      console.log(`vault:     ${vault}`);
      console.log(`reserved:  ${show(state.totalReserved, mint)} across ${sessions.length} open session(s)`);
      for (const { address: key, data } of sessions) {
        const model = ctx.deployment.models.find((entry) => entry.id === data.modelId);
        console.log("");
        console.log(`#${data.sessionId}  ${key}`);
        console.log(`  model:   ${model ? `${model.alias} (${data.modelId})` : data.modelId}`);
        console.log(`  cap:     ${show(data.reservedAmount, mint)}`);
        console.log(`  relayer: ${data.relayer}`);
        console.log(`  ${describeExpiry(data.expiresAt)}`);
      }
    });

  session
    .command("reclaim")
    .description("release the reservation of expired, unsettled sessions")
    .argument("[id]", "session id to reclaim (default: every expired session)")
    .option(...mintOption)
    .action(async (id: string | undefined, { mint: mintName }: { mint: string }) => {
      const { ctx, mint, vault } = await setup(program, mintName);
      const sessions = await listSessions(ctx, vault);
      const targets = id === undefined
        ? sessions.filter(({ data }) => data.expiresAt < nowSecs())
        : sessions.filter(({ data }) => data.sessionId === BigInt(id));
      if (id !== undefined && targets.length === 0) {
        throw new Error(`no open session with id ${id} on this vault`);
      }
      if (targets.length === 0) {
        console.log("no expired sessions to reclaim");
        return;
      }
      for (const { address: key, data } of targets) {
        await ctx.client.blockrouter.instructions
          .reclaimExpiredSession({ user: ctx.client.payer, vault, session: key })
          .sendTransaction();
        console.log(`reclaimed #${data.sessionId}: ${show(data.reservedAmount, mint)} released`);
      }
    });
}
