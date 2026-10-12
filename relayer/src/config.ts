import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export type ModelAlias = {
  id: number;
  alias: string;
  /** Model name sent to the upstream provider. */
  upstream: string;
  /** Provider id serving this model; null means the mock provider. */
  provider: string | null;
  /** False when providers are configured but none serves this model. */
  available: boolean;
};

export type UpstreamConfig = { baseUrl: string; apiKey: string };

export type Config = {
  host: string;
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
  /** Browser origins allowed to call the API (the dashboard). */
  corsOrigins: string[];
  /** OpenAI-compatible upstreams by provider id. Empty means the mock provider serves everything. */
  providers: Record<string, UpstreamConfig>;
};

const RPC_URLS = { devnet: "https://api.devnet.solana.com", localnet: "http://127.0.0.1:8899" };

/** Messages are fixed strings, never echoing supplied values, which may be secrets. */
export class ConfigurationError extends Error {}

export function validateUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:\/\//.test(value) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error();
    }
  } catch {
    throw new ConfigurationError(`${name} must be an absolute HTTP(S) URL without userinfo or a fragment`);
  }
  return value;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new ConfigurationError(`${name} must be a non-negative integer`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cluster = (env.CLUSTER ?? "devnet") as Config["cluster"];
  if (cluster !== "devnet" && cluster !== "localnet") throw new ConfigurationError("CLUSTER must be devnet or localnet");
  const host = env.HOST ?? "127.0.0.1";
  if (host !== "localhost" && isIP(host) === 0) throw new ConfigurationError("HOST must be an IP address or localhost");
  const port = int(env, "PORT", 8787);
  if (port < 1 || port > 65_535) throw new ConfigurationError("PORT must be an integer from 1 to 65535");

  const deploymentPath = env.DEPLOYMENT ?? new URL(`../../deployments/${cluster}.json`, import.meta.url);
  let deployment;
  try {
    deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  } catch {
    throw new ConfigurationError(`cannot read deployments/${cluster}.json (or DEPLOYMENT)`);
  }
  const deployed: { id: number; alias: string }[] = deployment.models;
  const { providers, routes } = env.PROVIDERS_FILE ? loadProvidersFile(env) : legacyUpstream(env, deployed);
  for (const alias of Object.keys(routes)) {
    if (!deployed.some((model) => model.alias === alias)) {
      throw new ConfigurationError(`model "${alias}" in the provider config is not in deployments/${cluster}.json`);
    }
  }
  const hasProviders = Object.keys(providers).length > 0;
  const rpcUrl = validateUrl(env.RPC_URL ?? RPC_URLS[cluster], "RPC_URL");
  // The mock provider bills real sessions for canned replies, so it is opt-in off the local chain.
  if (!hasProviders && cluster !== "localnet" && env.ALLOW_MOCK_PROVIDER !== "1") {
    throw new ConfigurationError("no upstream provider configured: set PROVIDERS_FILE or UPSTREAM_*, or ALLOW_MOCK_PROVIDER=1");
  }
  const models: ModelAlias[] = deployed.map((model) => {
    const route = routes[model.alias];
    return {
      id: model.id,
      alias: model.alias,
      upstream: route?.upstream ?? model.alias,
      provider: route?.provider ?? null,
      available: !hasProviders || route !== undefined,
    };
  });

  return {
    host,
    port,
    cluster,
    rpcUrl,
    relayerKeypair: env.RELAYER_KEYPAIR ?? "keys/relayer.json",
    dbPath: env.DB_PATH ?? "relayer.db",
    models,
    settleThresholdBps: int(env, "SETTLE_THRESHOLD_BPS", 8_000),
    settleBeforeExpirySecs: int(env, "SETTLE_BEFORE_EXPIRY_SECS", 600),
    settleIntervalSecs: int(env, "SETTLE_INTERVAL_SECS", 0),
    workerTickSecs: int(env, "WORKER_TICK_SECS", 15),
    rateLimitPerMinute: int(env, "RATE_LIMIT_PER_MINUTE", 60),
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    providers,
  };
}

type Route = { provider: string; upstream: string };
type Providers = { providers: Record<string, UpstreamConfig>; routes: Record<string, Route> };

// Single upstream from UPSTREAM_BASE_URL / UPSTREAM_API_KEY / UPSTREAM_MODELS.
function legacyUpstream(env: NodeJS.ProcessEnv, deployed: { alias: string }[]): Providers {
  const baseUrl = env.UPSTREAM_BASE_URL;
  const apiKey = env.UPSTREAM_API_KEY;
  if (Boolean(baseUrl) !== Boolean(apiKey)) {
    throw new ConfigurationError("set both UPSTREAM_BASE_URL and UPSTREAM_API_KEY, or neither to use the mock provider");
  }
  if (!baseUrl || !apiKey) return { providers: {}, routes: {} };
  // UPSTREAM_MODELS maps aliases to upstream names, e.g. "deepseek-v3=deepseek-chat".
  const names = new Map(
    (env.UPSTREAM_MODELS ?? "").split(",").filter(Boolean).map((pair) => pair.split("=") as [string, string]),
  );
  const routes: Record<string, Route> = {};
  for (const { alias } of deployed) routes[alias] = { provider: "upstream", upstream: names.get(alias) ?? alias };
  return { providers: { upstream: { baseUrl: validateUrl(baseUrl, "UPSTREAM_BASE_URL"), apiKey } }, routes };
}

// PROVIDERS_FILE: { providers: { <id>: { baseUrl, apiKeyEnv } }, models: { <alias>: { provider, upstream } } }.
// Keys stay in the environment; the file only names the variable.
function loadProvidersFile(env: NodeJS.ProcessEnv): Providers {
  if (env.UPSTREAM_BASE_URL || env.UPSTREAM_API_KEY) {
    throw new ConfigurationError("use either PROVIDERS_FILE or UPSTREAM_BASE_URL/UPSTREAM_API_KEY, not both");
  }
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(env.PROVIDERS_FILE!, "utf8"));
  } catch {
    throw new ConfigurationError("cannot read PROVIDERS_FILE as JSON");
  }
  if (!raw || typeof raw.providers !== "object" || typeof raw.models !== "object") {
    throw new ConfigurationError('PROVIDERS_FILE needs "providers" and "models" objects');
  }
  const providers: Record<string, UpstreamConfig> = {};
  for (const [id, provider] of Object.entries<any>(raw.providers)) {
    if (typeof provider?.baseUrl !== "string" || typeof provider?.apiKeyEnv !== "string") {
      throw new ConfigurationError(`provider "${id}" needs baseUrl and apiKeyEnv`);
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(provider.apiKeyEnv)) {
      // Catches a key pasted where the variable name belongs, without echoing it.
      throw new ConfigurationError(
        `provider "${id}" apiKeyEnv must be the NAME of an environment variable (like DEEPSEEK_API_KEY), not the key`,
      );
    }
    const apiKey = env[provider.apiKeyEnv];
    if (!apiKey || !apiKey.trim()) {
      throw new ConfigurationError(`provider "${id}" needs ${provider.apiKeyEnv} set in the environment`);
    }
    providers[id] = { baseUrl: validateUrl(provider.baseUrl, `provider "${id}" baseUrl`), apiKey };
  }
  const routes: Record<string, Route> = {};
  for (const [alias, route] of Object.entries<any>(raw.models)) {
    if (typeof route?.provider !== "string" || typeof route?.upstream !== "string") {
      throw new ConfigurationError(`model "${alias}" needs provider and upstream`);
    }
    if (!providers[route.provider]) {
      throw new ConfigurationError(`model "${alias}" uses unknown provider "${route.provider}"`);
    }
    routes[alias] = { provider: route.provider, upstream: route.upstream };
  }
  return { providers, routes };
}
