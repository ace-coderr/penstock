import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxyTarget = process.env.PENSTOCK_PROXY_URL ?? "http://localhost:4020";

/**
 * `vite build --mode static` produces the hosted demo: a fully static site whose API is answered
 * in the browser (src/static), with no server calls. Its public files (snapshot, _redirects,
 * _headers) live in static-public/.
 */
export default defineConfig(({ mode }) => {
  const isStatic = mode === "static";
  return {
    plugins: [react()],
    define: { "import.meta.env.VITE_STATIC_DEMO": JSON.stringify(isStatic ? "1" : "") },
    publicDir: isStatic ? "static-public" : false,
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
    server: {
      port: Number(process.env.CONSOLE_PORT ?? 4021),
      strictPort: true,
      proxy: { "/api": proxyTarget, "/p": proxyTarget, "/.well-known": proxyTarget, "/healthz": proxyTarget },
    },
    preview: { port: Number(process.env.PREVIEW_PORT ?? 4031), strictPort: true },
  };
});
