import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { address, type Address } from "@solana/kit";
import { parse } from "toml";

const root = new URL("../../../", import.meta.url);
export const defaultIdlPath = fileURLToPath(
  new URL("target/idl/blockrouter.json", root),
);
export const anchorConfigPath = fileURLToPath(new URL("Anchor.toml", root));
const endpoints = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
} as const;
export type Cluster = keyof typeof endpoints;

/** Safe messages are fixed strings, never interpolated environment values. */
export class ConfigurationError extends Error {}

export interface RelayerConfig {
  host: string;
  port: number;
  cluster: Cluster;
  rpcUrl: string;
  programId: Address;
  idlPath: string;
  providerApiKey?: string;
}

export function validateRpcUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      !/^https?:\/\//.test(value) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new ConfigurationError(
      "RPC_URL must be an absolute HTTP(S) URL without userinfo or a fragment.",
    );
  }
  return value;
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  anchorPath = anchorConfigPath,
): Promise<RelayerConfig> {
  let anchor;
  try {
    anchor = parse(await readFile(anchorPath, "utf8"));
  } catch {
    throw new ConfigurationError(
      "Cannot read Anchor.toml from the BlockRouter checkout.",
    );
  }
  const host = env.HOST ?? "127.0.0.1";
  if (host !== "localhost" && isIP(host) === 0)
    throw new ConfigurationError("HOST must be an IP address or localhost.");
  const portText = env.PORT ?? "3000";
  if (
    !/^\d+$/.test(portText) ||
    Number(portText) < 1 ||
    Number(portText) > 65535
  )
    throw new ConfigurationError("PORT must be an integer from 1 to 65535.");
  const cluster = env.SOLANA_CLUSTER ?? anchor.provider?.cluster;
  if (typeof cluster !== "string" || !Object.hasOwn(endpoints, cluster))
    throw new ConfigurationError(
      "SOLANA_CLUSTER must be localnet, devnet or mainnet-beta.",
    );
  const selected = cluster as Cluster;
  const configuredId = anchor.programs?.localnet?.blockrouter;
  if (
    typeof configuredId !== "string" ||
    configuredId !== anchor.programs?.devnet?.blockrouter
  )
    throw new ConfigurationError(
      "Anchor.toml must define consistent BlockRouter program addresses.",
    );
  let programId: Address;
  try {
    programId = address(env.PROGRAM_ID ?? configuredId);
  } catch {
    throw new ConfigurationError("PROGRAM_ID must be a valid Solana address.");
  }
  if (programId !== configuredId)
    throw new ConfigurationError("PROGRAM_ID must match Anchor.toml.");
  const idlPath = env.IDL_PATH ?? defaultIdlPath;
  if (!idlPath.trim())
    throw new ConfigurationError("IDL_PATH must not be empty.");
  const providerApiKey = env.OPENAI_API_KEY || undefined;
  if (providerApiKey && !providerApiKey.trim())
    throw new ConfigurationError(
      "OPENAI_API_KEY must not be blank when configured.",
    );
  return {
    host,
    port: Number(portText),
    cluster: selected,
    rpcUrl: validateRpcUrl(env.RPC_URL ?? endpoints[selected]),
    programId,
    idlPath,
    // Optional until an upstream provider is implemented. No file or hardcoded fallback.
    providerApiKey,
  };
}
