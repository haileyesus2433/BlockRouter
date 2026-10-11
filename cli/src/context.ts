import { createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { tokenProgram } from "@solana-program/token";
import { BLOCKROUTER_PROGRAM_ADDRESS, blockrouterProgram } from "@blockrouter/client";

import { type Cluster, defaultRpcUrl, loadDeployment } from "./deployment";
import { describeRpc, validateRpcUrl } from "./rpc";
import { loadWallet, walletPath } from "./wallet";

export type GlobalOptions = {
  cluster: Cluster;
  url?: string;
  keypair?: string;
};

export async function createContext(options: GlobalOptions) {
  const keypairPath = walletPath(options.keypair);
  const wallet = await loadWallet(keypairPath);
  const deployment = loadDeployment(options.cluster);
  if (deployment.programId !== BLOCKROUTER_PROGRAM_ADDRESS) {
    throw new Error(
      `deployment program ${deployment.programId} does not match client ${BLOCKROUTER_PROGRAM_ADDRESS}`,
    );
  }
  const rpcUrl = validateRpcUrl(options.url ?? defaultRpcUrl(options.cluster));
  const client = createClient()
    .use(signer(wallet))
    .use(solanaRpc({ rpcUrl }))
    .use(tokenProgram())
    .use(blockrouterProgram());
  return { client, deployment, keypairPath, rpc: describeRpc(rpcUrl, options.url !== undefined) };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
