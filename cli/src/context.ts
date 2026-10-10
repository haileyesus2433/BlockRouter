import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { tokenProgram } from "@solana-program/token";
import { BLOCKROUTER_PROGRAM_ADDRESS, blockrouterProgram } from "@blockrouter/client";

import { type Cluster, defaultRpcUrl, loadDeployment } from "./deployment";

export type GlobalOptions = {
  cluster: Cluster;
  url?: string;
  keypair?: string;
};

export function resolveKeypairPath(path: string | undefined): string {
  const raw = path ?? process.env.BR_KEYPAIR ?? "~/.config/solana/id.json";
  return resolve(raw.startsWith("~/") ? `${homedir()}${raw.slice(1)}` : raw);
}

export async function createContext(options: GlobalOptions) {
  const keypairPath = resolveKeypairPath(options.keypair);
  if (!existsSync(keypairPath)) {
    throw new Error(
      `keypair not found at ${keypairPath}. Pass --keypair <path> or set BR_KEYPAIR.`,
    );
  }
  const deployment = loadDeployment(options.cluster);
  if (deployment.programId !== BLOCKROUTER_PROGRAM_ADDRESS) {
    throw new Error(
      `deployment program ${deployment.programId} does not match client ${BLOCKROUTER_PROGRAM_ADDRESS}`,
    );
  }
  const rpcUrl = options.url ?? defaultRpcUrl(options.cluster);
  const client = await createClient()
    .use(signerFromFile(keypairPath))
    .use(solanaRpc({ rpcUrl }))
    .use(tokenProgram())
    .use(blockrouterProgram());
  return { client, deployment, keypairPath, rpcUrl };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
