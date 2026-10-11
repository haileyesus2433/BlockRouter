#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { loadWallet } from "./wallet.js";
import { loadProjectConfig, selectCluster } from "./config.js";
import { createProgramClient } from "./client.js";

const { version } = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
const cli = new Command()
  .name("br")
  .description(
    "BlockRouter CLI: load a wallet and initialize an offline program client.",
  )
  .version(version)
  .option(
    "--wallet <path>",
    "Solana keypair JSON (default: Anchor.toml provider wallet)",
  )
  .option(
    "--cluster <name>",
    "localnet, devnet or mainnet-beta (default: Anchor.toml provider cluster)",
  )
  .option("--rpc-url <url>", "Override the cluster's HTTP(S) RPC endpoint")
  .option(
    "--idl <path>",
    "Generated Anchor IDL (default: target/idl/blockrouter.json)",
  )
  .addHelpText(
    "after",
    "\nInitialization sends no transactions or RPC requests. Vault and Session commands are not yet available.",
  )
  .action(async (options) => {
    const config = await loadProjectConfig();
    const { cluster, endpoint } = selectCluster(
      options.cluster ?? config.cluster,
      options.rpcUrl,
    );
    const wallet = await loadWallet(options.wallet ?? config.wallet);
    const client = await createProgramClient({
      endpoint,
      wallet,
      programAddress: config.programAddress,
      idlPath: options.idl,
    });
    console.log(
      `Wallet: ${wallet.address}\nCluster: ${cluster}\nProgram: ${client.programAddress}\nClient initialized offline; deployment has not been verified.`,
    );
  });

try {
  await cli.parseAsync();
} catch (error) {
  console.error(
    `br: ${error instanceof Error ? error.message : "Initialization failed."}`,
  );
  process.exitCode = 1;
}
