import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig, ConfigurationError } from "./config.js";
import { createProgramClient } from "./client.js";

async function main() {
  const config = await loadConfig();
  await createProgramClient(config);
  const app = createApp();
  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
  server.on("listening", () => console.log("blockrouter-relayer listening"));
  server.on("error", () => {
    console.error("Relayer HTTP server failed to listen. Check HOST and PORT.");
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close());
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof ConfigurationError
      ? error.message
      : "Relayer startup failed.",
  );
  process.exitCode = 1;
});
