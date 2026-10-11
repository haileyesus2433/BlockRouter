import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The generated client reads process.env["NODE_ENV"], which Vite does not rewrite on its own.
  define: { "process.env": JSON.stringify({ NODE_ENV: mode }) },
  server: { port: 5173, host: "127.0.0.1" },
}));
