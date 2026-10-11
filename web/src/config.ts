import { type Address, address } from "@solana/kit";

export type Cluster = "localnet" | "devnet";

export type ModelInfo = { id: number; alias: string; promptRate: number; completionRate: number };

export type Deployment = {
  programId: Address;
  usdcMint: Address;
  mockUsdtMint: Address | null;
  relayerUrl: string | null;
  models: ModelInfo[];
};

// Deployment records live in ../deployments; localnet.json is written by the seed script.
const records = import.meta.glob("../../deployments/*.json", { eager: true, import: "default" }) as Record<
  string,
  Record<string, any>
>;

export const cluster: Cluster = import.meta.env.VITE_CLUSTER === "devnet" ? "devnet" : "localnet";

function loadDeployment(): Deployment | null {
  const raw = records[`../../deployments/${cluster}.json`];
  if (!raw) return null;
  return {
    programId: address(raw.programId),
    usdcMint: address(raw.usdcMint),
    mockUsdtMint: raw.mockUsdtMint ? address(raw.mockUsdtMint) : null,
    relayerUrl: raw.relayerUrl ?? null,
    models: raw.models,
  };
}

export const deployment = loadDeployment();

export const rpcUrl: string =
  import.meta.env.VITE_RPC_URL ?? (cluster === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899");

export const relayerUrl: string = (
  import.meta.env.VITE_RELAYER_URL ?? deployment?.relayerUrl ?? "http://127.0.0.1:8787"
).replace(/\/$/, "");

export const walletChain = `solana:${cluster}` as const;

export function explorerTx(signature: string): string {
  const query = cluster === "devnet" ? "cluster=devnet" : `cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  return `https://explorer.solana.com/tx/${signature}?${query}`;
}

export function modelAlias(id: number): string {
  return deployment?.models.find((model) => model.id === id)?.alias ?? `model-${id}`;
}
