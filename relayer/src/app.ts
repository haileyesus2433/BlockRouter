import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Chain } from "./chain/types";
import type { Config } from "./config";
import { ApiError, errorResponse } from "./errors";
import type { Ledger } from "./ledger";
import type { Provider } from "./providers/types";
import { chatRoutes } from "./routes/chat";
import { infoRoutes } from "./routes/info";
import { keyRoutes } from "./routes/keys";
import { sessionRoutes } from "./routes/sessions";
import type { Store } from "./store";

export type Deps = {
  config: Config;
  chain: Chain;
  /** Serves models without a configured upstream: the mock provider. */
  provider: Provider;
  /** Upstream providers by id, from PROVIDERS_FILE or UPSTREAM_*. */
  providers: Map<string, Provider>;
  store: Store;
  ledger: Ledger;
  /** Wall clock in unix seconds, injectable for tests. */
  nowSecs: () => number;
};

export function createApp(deps: Deps) {
  const app = new Hono();

  // Exception text can carry upstream credentials, so it is never returned or logged.
  app.onError((error, c) => {
    if (error instanceof ApiError) return errorResponse(c, error);
    console.error(JSON.stringify({ event: "unhandled_error", kind: error instanceof Error ? error.name : typeof error }));
    return errorResponse(c, new ApiError(500, "api_error", "internal_error", "internal relayer error"));
  });
  app.notFound((c) => errorResponse(c, new ApiError(404, "not_found_error", "not_found", "no such route")));

  app.use(
    "*",
    cors({
      origin: deps.config.corsOrigins,
      allowHeaders: ["Authorization", "Content-Type", "X-BlockRouter-Address", "X-BlockRouter-Timestamp", "X-BlockRouter-Signature"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["X-BlockRouter-Session", "X-BlockRouter-Charge", "X-BlockRouter-Remaining", "X-BlockRouter-Session-Expires"],
    }),
  );

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      cluster: deps.config.cluster,
      relayer: deps.chain.relayer,
      provider: deps.providers.size > 0 ? "upstream" : deps.provider.id,
      providers: [...deps.providers.keys()],
    }),
  );
  app.route("/v1/keys", keyRoutes(deps));
  app.route("/v1/sessions", sessionRoutes(deps));
  app.route("/v1", infoRoutes(deps));
  app.route("/v1", chatRoutes(deps));

  return app;
}
