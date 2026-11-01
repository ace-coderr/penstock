import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxyTarget = process.env.PENSTOCK_PROXY_URL ?? "http://localhost:4020";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.CONSOLE_PORT ?? 4021),
    strictPort: true,
    proxy: { "/api": proxyTarget, "/p": proxyTarget, "/.well-known": proxyTarget, "/healthz": proxyTarget },
  },
});
