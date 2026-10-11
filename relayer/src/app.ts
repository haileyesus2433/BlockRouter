import { Hono } from "hono";
import type { ModelRegistry } from "./models.js";

/** Liveness only. Constructing this app reads no config and contacts no services. */
export function createApp(registry?: ModelRegistry) {
  const app = new Hono();
  app.get("/health", (c) =>
    c.json({ status: "ok", service: "blockrouter-relayer" }),
  );
  app.get("/v1/models", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!registry) return c.json({ error: "Model registry unavailable" }, 503);
    try {
      return c.json({ object: "list", data: await registry.list() });
    } catch {
      return c.json({ error: "Model registry unavailable" }, 503);
    }
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  // Never return or log exception messages; upstream errors may contain credentials.
  app.onError((_error, c) => c.json({ error: "Internal server error" }, 500));
  return app;
}
