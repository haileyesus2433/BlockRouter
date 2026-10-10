import { Command, Option } from "commander";

import { registerVaultCommands } from "./commands/vault";
import { createContext, type GlobalOptions } from "./context";
import { describeError } from "./errors";
import { formatSol } from "./format";

const program = new Command()
  .name("br")
  .description("BlockRouter: self-custodial stablecoin payments for AI inference")
  .version("0.1.0")
  .addOption(
    new Option("-c, --cluster <cluster>", "cluster to use")
      .choices(["devnet", "localnet"])
      .default("devnet"),
  )
  .option("-u, --url <url>", "custom RPC URL for the cluster")
  .option("-k, --keypair <path>", "wallet keypair (default: $BR_KEYPAIR or ~/.config/solana/id.json)")
  .showHelpAfterError();

program
  .command("wallet")
  .description("show the loaded wallet, its SOL balance, and the cluster")
  .action(async () => {
    const { client, deployment, keypairPath, rpcUrl } = await createContext(
      program.opts<GlobalOptions>(),
    );
    const { value } = await client.rpc.getBalance(client.payer.address).send();
    console.log(`wallet:  ${client.payer.address}`);
    console.log(`keypair: ${keypairPath}`);
    console.log(`balance: ${formatSol(value)} SOL`);
    console.log(`cluster: ${deployment.cluster} (${rpcUrl})`);
    console.log(`program: ${deployment.programId}`);
  });

registerVaultCommands(program);

program.parseAsync().catch((error: unknown) => {
  console.error(`error: ${describeError(error)}`);
  process.exit(1);
});
