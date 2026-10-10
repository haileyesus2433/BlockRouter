import { Hono } from "hono";

import type { Chain } from "./chain/types";
import type { Config } from "./config";
import { ApiError, errorResponse } from "./errors";
import type { Ledger } from "./ledger";
import type { Provider } from "./providers/types";
import { infoRoutes } from "./routes/info";
import { keyRoutes } from "./routes/keys";
import type { Store } from "./store";

export type Deps = {
  config: Config;
  chain: Chain;
  provider: Provider;
  store: Store;
  ledger: Ledger;
  /** Wall clock in unix seconds, injectable for tests. */
  nowSecs: () => number;
};

export function createApp(deps: Deps) {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof ApiError) return errorResponse(c, error);
    console.error("unhandled error", error instanceof Error ? error.message : error);
    return errorResponse(c, new ApiError(500, "api_error", "internal_error", "internal relayer error"));
  });

  app.get("/health", (c) =>
    c.json({ status: "ok", cluster: deps.config.cluster, provider: deps.provider.id }),
  );
  app.route("/v1/keys", keyRoutes(deps));
  app.route("/v1", infoRoutes(deps));

  return app;
}
