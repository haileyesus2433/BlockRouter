import type { Command } from "commander";
import { type Address, address, isAddress } from "@solana/kit";
import { fetchMaybeVault, findSessionPda, findVaultPda } from "@blockrouter/client";

import { createContext, type GlobalOptions } from "../context";
import { loadMint } from "../mint";
import { relayerRequest, relayerUrl } from "../relayer";

type KeyRecord = {
  id: string;
  name: string;
  session: string;
  created_at: number;
  revoked_at: number | null;
  max_tokens: number | null;
};

const MAX_TOKENS_LIMIT = 200_000;

function parseMaxTokens(value: string): number | null {
  if (value === "default") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TOKENS_LIMIT) {
    throw new Error(`--max-tokens must be an integer from 1 to ${MAX_TOKENS_LIMIT}, or "default"`);
  }
  return n;
}

async function setup(program: Command, options: { relayerUrl?: string }) {
  const ctx = await createContext(program.opts<GlobalOptions>());
  return { ctx, url: relayerUrl(options.relayerUrl, ctx.deployment.relayerUrl) };
}

function date(unixSecs: number): string {
  return new Date(unixSecs * 1000).toISOString().replace(".000Z", "Z");
}

export function registerKeyCommands(program: Command) {
  const key = program.command("key").description("create and manage relayer API keys bound to a session");
  const urlOption = ["--relayer-url <url>", "relayer base URL (default: $BR_RELAYER_URL, deployment, or localhost:8787)"] as const;

  key
    .command("create")
    .description("create an API key for one of your open sessions; shown once")
    .requiredOption("--name <name>", "label for the key, e.g. opencode")
    .option("--session <id|address>", "session id or address (default: your newest open session)")
    .option("-m, --mint <mint>", "usdt, usdc, or a mint address (used to find the session)", "usdt")
    .option(
      "--max-tokens <n>",
      "response length used when a client does not send max_tokens; raise it for long file writes (relayer default 4096)",
    )
    .option(...urlOption)
    .action(async (options: { name: string; session?: string; mint: string; maxTokens?: string; relayerUrl?: string }) => {
      const maxTokens = options.maxTokens === undefined ? null : parseMaxTokens(options.maxTokens);
      const { ctx, url } = await setup(program, options);
      const session = await resolveSession(ctx, options.session, options.mint);
      const created = await relayerRequest<{ id: string; key: string; session: string }>(
        url,
        ctx.client.payer,
        "POST",
        "/v1/keys",
        { name: options.name, session, ...(maxTokens !== null ? { max_tokens: maxTokens } : {}) },
      );
      console.log(`key created: ${created.id} (${options.name}) for session ${created.session}`);
      if (maxTokens !== null) console.log(`default max_tokens: ${maxTokens}`);
      console.log("");
      console.log(`  ${created.key}`);
      console.log("");
      console.log("This is the only time the key is shown. Store it now. It can spend at most the session's cap.");
      console.log("");
      console.log(`  export OPENAI_BASE_URL="${url}/v1"`);
      console.log(`  export OPENAI_API_KEY="${created.key}"`);
    });

  key
    .command("list")
    .description("list your API keys")
    .option(...urlOption)
    .action(async (options: { relayerUrl?: string }) => {
      const { ctx, url } = await setup(program, options);
      const { data } = await relayerRequest<{ data: KeyRecord[] }>(url, ctx.client.payer, "GET", "/v1/keys");
      if (data.length === 0) {
        console.log("no keys. Create one with `br key create --name <name>`.");
        return;
      }
      for (const record of data) {
        const status = record.revoked_at === null ? "active" : `revoked ${date(record.revoked_at)}`;
        const limit = `max_tokens ${record.max_tokens ?? "default"}`;
        console.log(`${record.id}  ${record.name.padEnd(16)} ${status.padEnd(28)} ${limit.padEnd(18)} session ${record.session}`);
      }
    });

  key
    .command("update")
    .description("change a key's default max_tokens")
    .argument("<id>", "key id from `br key list`")
    .requiredOption("--max-tokens <n>", 'new default, or "default" to use the relayer default')
    .option(...urlOption)
    .action(async (id: string, options: { maxTokens: string; relayerUrl?: string }) => {
      const maxTokens = parseMaxTokens(options.maxTokens);
      const { ctx, url } = await setup(program, options);
      await relayerRequest(url, ctx.client.payer, "PATCH", `/v1/keys/${encodeURIComponent(id)}`, { max_tokens: maxTokens });
      console.log(`${id}: default max_tokens ${maxTokens ?? "reset to the relayer default"}`);
    });

  key
    .command("revoke")
    .description("revoke an API key immediately")
    .argument("<id>", "key id from `br key list`")
    .option(...urlOption)
    .action(async (id: string, options: { relayerUrl?: string }) => {
      const { ctx, url } = await setup(program, options);
      await relayerRequest(url, ctx.client.payer, "DELETE", `/v1/keys/${encodeURIComponent(id)}`);
      console.log(`revoked ${id}`);
    });
}

async function resolveSession(
  ctx: Awaited<ReturnType<typeof createContext>>,
  input: string | undefined,
  mintName: string,
): Promise<Address> {
  if (input && isAddress(input)) return address(input);
  const mint = await loadMint(ctx, mintName);
  const [vault] = await findVaultPda({ user: ctx.client.payer.address, mint: mint.address });
  const account = await fetchMaybeVault(ctx.client.rpc, vault);
  if (!account.exists) throw new Error("no vault for this wallet and mint. Run `br vault init` first.");

  if (input !== undefined) {
    if (!/^\d+$/.test(input)) throw new Error(`--session must be a session id or address, got "${input}"`);
    return (await findSessionPda({ vault, sessionId: BigInt(input) }))[0];
  }
  // Newest session id that still exists on-chain.
  for (let id = account.data.sessionCounter - 1n; id >= 0n; id -= 1n) {
    const [session] = await findSessionPda({ vault, sessionId: id });
    const { value } = await ctx.client.rpc.getAccountInfo(session, { encoding: "base64" }).send();
    if (value) return session;
  }
  throw new Error("no open session. Open one with `br session open --cap <amount> --model <model>`.");
}
