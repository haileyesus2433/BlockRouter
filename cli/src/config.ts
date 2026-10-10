import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "toml";
import { address } from "@solana/kit";

const projectRoot = new URL("../../../", import.meta.url);
export const defaultIdlPath = fileURLToPath(
  new URL("target/idl/blockrouter.json", projectRoot),
);
export const anchorConfigPath = fileURLToPath(
  new URL("Anchor.toml", projectRoot),
);

const endpoints = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
} as const;

export function validateRpcUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (
      !/^https?:\/\//.test(endpoint) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error("Invalid RPC URL");
    }
  } catch {
    throw new Error(
      "RPC URL must be an absolute HTTP(S) URL without userinfo or a fragment.",
    );
  }
  return endpoint;
}

export function selectCluster(cluster: string, rpcUrl?: string) {
  if (!Object.hasOwn(endpoints, cluster)) {
    throw new Error(
      "Unsupported cluster. Use localnet, devnet or mainnet-beta.",
    );
  }
  const selected = cluster as keyof typeof endpoints;
  return {
    cluster: selected,
    endpoint: validateRpcUrl(rpcUrl ?? endpoints[selected]),
  };
}

export async function loadProjectConfig(path = anchorConfigPath) {
  let config;
  try {
    config = parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(
      "Cannot read Anchor.toml. Run br from a built BlockRouter checkout.",
    );
  }
  const cluster = config.provider?.cluster;
  const wallet = config.provider?.wallet;
  const localId = config.programs?.localnet?.blockrouter;
  const devnetId = config.programs?.devnet?.blockrouter;
  if (
    typeof cluster !== "string" ||
    typeof wallet !== "string" ||
    typeof localId !== "string" ||
    localId !== devnetId
  ) {
    throw new Error(
      "Anchor.toml must define a provider and matching localnet/devnet BlockRouter IDs.",
    );
  }
  selectCluster(cluster);
  try {
    return { cluster, wallet, programAddress: address(localId) };
  } catch {
    throw new Error(
      "Anchor.toml contains an invalid BlockRouter program address.",
    );
  }
}
