import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { createKitChain } from "./chain/kit";
import { ConfigurationError, loadConfig } from "./config";
import { Ledger } from "./ledger";
import { MockProvider } from "./providers/mock";
import { OpenAICompatibleProvider } from "./providers/openai";
import { createRedactor } from "./redact";
import { Store } from "./store";
import { SettlementWorker } from "./worker";

async function main() {
  const config = loadConfig();
  const upstreams = Object.values(config.providers);
  const redact = createRedactor([config.rpcUrl, ...upstreams.flatMap((upstream) => [upstream.apiKey, upstream.baseUrl])]);
  const chain = await createKitChain({ rpcUrl: config.rpcUrl, relayerKeypair: config.relayerKeypair });
  const provider = new MockProvider();
  const providers = new Map(
    Object.entries(config.providers).map(([id, upstream]) => [id, new OpenAICompatibleProvider(upstream)]),
  );
  const store = new Store(config.dbPath);
  const ledger = new Ledger(store, chain, config.models);
  const nowSecs = () => Math.floor(Date.now() / 1000);
  const app = createApp({ config, chain, provider, providers, store, ledger, nowSecs });

  const worker = new SettlementWorker({ config, chain, store, ledger, nowSecs, redact });
  worker.start();

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, ({ port }) => {
    const served = providers.size > 0 ? [...providers.keys()].join(", ") : "mock";
    console.log(`relayer ${chain.relayer} listening on ${config.host}:${port} (${config.cluster}, providers: ${served})`);
  });
  server.on("error", () => {
    console.error("relayer HTTP server failed to listen. Check HOST and PORT.");
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      worker.stop();
      server.close(() => store.close());
    });
  }
}

main().catch((error: unknown) => {
  // Configuration messages are fixed strings; anything else may carry secrets.
  console.error(error instanceof ConfigurationError ? error.message : "relayer startup failed. Check the relayer keypair and RPC.");
  process.exitCode = 1;
});
