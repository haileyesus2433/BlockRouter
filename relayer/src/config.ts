import { readFileSync } from "node:fs";

export type ModelAlias = {
  id: number;
  alias: string;
  /** Model name sent to the upstream provider. */
  upstream: string;
};

export type Config = {
  port: number;
  cluster: "devnet" | "localnet";
  rpcUrl: string;
  relayerKeypair: string;
  dbPath: string;
  models: ModelAlias[];
  settleThresholdBps: number;
  settleBeforeExpirySecs: number;
  settleIntervalSecs: number;
  workerTickSecs: number;
  rateLimitPerMinute: number;
  upstream: { baseUrl: string; apiKey: string } | null;
};

const RPC_URLS = { devnet: "https://api.devnet.solana.com", localnet: "http://127.0.0.1:8899" };

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cluster = (env.CLUSTER ?? "devnet") as Config["cluster"];
  if (cluster !== "devnet" && cluster !== "localnet") throw new Error("CLUSTER must be devnet or localnet");

  const deploymentPath = env.DEPLOYMENT ?? new URL(`../../deployments/${cluster}.json`, import.meta.url);
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  // UPSTREAM_MODELS maps aliases to upstream names, e.g. "deepseek-v3=deepseek-chat".
  const upstreamNames = new Map(
    (env.UPSTREAM_MODELS ?? "").split(",").filter(Boolean).map((pair) => pair.split("=") as [string, string]),
  );
  const models: ModelAlias[] = deployment.models.map((model: { id: number; alias: string }) => ({
    id: model.id,
    alias: model.alias,
    upstream: upstreamNames.get(model.alias) ?? model.alias,
  }));

  const baseUrl = env.UPSTREAM_BASE_URL;
  const apiKey = env.UPSTREAM_API_KEY;
  if (Boolean(baseUrl) !== Boolean(apiKey)) {
    throw new Error("set both UPSTREAM_BASE_URL and UPSTREAM_API_KEY, or neither to use the mock provider");
  }

  return {
    port: int(env, "PORT", 8787),
    cluster,
    rpcUrl: env.RPC_URL ?? RPC_URLS[cluster],
    relayerKeypair: env.RELAYER_KEYPAIR ?? "keys/relayer.json",
    dbPath: env.DB_PATH ?? "relayer.db",
    models,
    settleThresholdBps: int(env, "SETTLE_THRESHOLD_BPS", 8_000),
    settleBeforeExpirySecs: int(env, "SETTLE_BEFORE_EXPIRY_SECS", 600),
    settleIntervalSecs: int(env, "SETTLE_INTERVAL_SECS", 0),
    workerTickSecs: int(env, "WORKER_TICK_SECS", 15),
    rateLimitPerMinute: int(env, "RATE_LIMIT_PER_MINUTE", 60),
    upstream: baseUrl && apiKey ? { baseUrl, apiKey } : null,
  };
}
