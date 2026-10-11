import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { address, type Address } from "@solana/kit";

export type Cluster = "devnet" | "localnet";

export type Deployment = {
  cluster: Cluster;
  programId: Address;
  usdcMint: Address;
  mockUsdtMint: Address | null;
  relayer: Address | null;
  models: { id: number; alias: string; promptRate: number; completionRate: number }[];
};

const RPC_URLS: Record<Cluster, string> = {
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export function defaultRpcUrl(cluster: Cluster): string {
  return RPC_URLS[cluster];
}

export function loadDeployment(cluster: Cluster): Deployment {
  const path = fileURLToPath(new URL(`../../deployments/${cluster}.json`, import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    cluster,
    programId: address(raw.programId),
    usdcMint: address(raw.usdcMint),
    mockUsdtMint: raw.mockUsdtMint ? address(raw.mockUsdtMint) : null,
    relayer: raw.relayer ? address(raw.relayer) : null,
    models: raw.models,
  };
}
