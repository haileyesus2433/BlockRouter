import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { createKitChain } from "./chain/kit";
import { loadConfig } from "./config";
import { Ledger } from "./ledger";
import { MockProvider } from "./providers/mock";
import { OpenAICompatibleProvider } from "./providers/openai";
import { Store } from "./store";

const config = loadConfig();
const chain = await createKitChain({ rpcUrl: config.rpcUrl, relayerKeypair: config.relayerKeypair });
const provider = config.upstream ? new OpenAICompatibleProvider(config.upstream) : new MockProvider();
const store = new Store(config.dbPath);
const ledger = new Ledger(store, chain, config.models);
const app = createApp({ config, chain, provider, store, ledger, nowSecs: () => Math.floor(Date.now() / 1000) });

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`relayer listening on :${port} (${config.cluster}, provider ${provider.id})`);
});
