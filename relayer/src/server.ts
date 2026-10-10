import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { createKitChain } from "./chain/kit";
import { loadConfig } from "./config";
import { MockProvider } from "./providers/mock";

const config = loadConfig();
const chain = await createKitChain({ rpcUrl: config.rpcUrl, relayerKeypair: config.relayerKeypair });
const provider = new MockProvider();
const app = createApp({ config, chain, provider });

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`relayer listening on :${port} (${config.cluster}, provider ${provider.id})`);
});
