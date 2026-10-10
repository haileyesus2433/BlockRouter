import { Hono } from "hono";

import type { Chain } from "./chain/types";
import type { Config } from "./config";
import type { Provider } from "./providers/types";

export type Deps = {
  config: Config;
  chain: Chain;
  provider: Provider;
};

export function createApp(deps: Deps) {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ status: "ok", cluster: deps.config.cluster, provider: deps.provider.id }),
  );

  return app;
}
