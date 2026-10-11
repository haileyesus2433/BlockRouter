import { Hono } from "hono";

/** Liveness only. Constructing this app reads no config and contacts no services. */
export function createApp() {
  const app = new Hono();
  app.get("/health", (c) =>
    c.json({ status: "ok", service: "blockrouter-relayer" }),
  );
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  // Never return or log exception messages; upstream errors may contain credentials.
  app.onError((_error, c) => c.json({ error: "Internal server error" }, 500));
  return app;
}
