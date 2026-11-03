import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { faviconSvg, socialCardPng } from "./scripts/share-assets";

const proxyTarget = process.env.PENSTOCK_PROXY_URL ?? "http://localhost:4020";

/**
 * Share assets (favicon.svg, social-card.png) and proof.json are generated or copied at build time and emitted next to
 * index.html, so they are served from the same origin and the CSP stays strict. SITE_URL, when
 * set at build time, makes the card URL in the Open Graph / Twitter tags absolute.
 */
function shareAssets(): Plugin {
  const site = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
  const files: Record<string, { type: string; body: () => string | Uint8Array }> = {
    "/favicon.svg": { type: "image/svg+xml", body: faviconSvg },
    "/social-card.png": { type: "image/png", body: socialCardPng },
    // The real mainnet transactions (docs/PROOF.md), served same-origin for the Real view.
    "/proof.json": { type: "application/json", body: () => readFileSync(new URL("../../docs/proof.json", import.meta.url), "utf8") },
  };
  return {
    name: "penstock-share-assets",
    transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", site),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const f = files[req.url ?? ""];
        if (!f) return next();
        res.setHeader("content-type", f.type);
        res.end(f.body());
      });
    },
    generateBundle() {
      for (const [path, f] of Object.entries(files)) this.emitFile({ type: "asset", fileName: path.slice(1), source: f.body() });
    },
  };
}

/**
 * `vite build --mode static` produces the hosted demo: a fully static site whose API is answered
 * in the browser (src/static), with no server calls. Its public files (snapshot, _redirects,
 * _headers) live in static-public/.
 */
export default defineConfig(({ mode }) => {
  const isStatic = mode === "static";
  return {
    plugins: [react(), shareAssets()],
    define: { "import.meta.env.VITE_STATIC_DEMO": JSON.stringify(isStatic ? "1" : "") },
    publicDir: isStatic ? "static-public" : false,
    // No data: URIs in the static build: every asset is a same-origin file, so the strict CSP
    // (font-src 'self') in static-public/_headers holds without exceptions.
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false, assetsInlineLimit: isStatic ? 0 : undefined },
    server: {
      port: Number(process.env.CONSOLE_PORT ?? 4021),
      strictPort: true,
      proxy: { "/api": proxyTarget, "/p": proxyTarget, "/.well-known": proxyTarget, "/healthz": proxyTarget },
    },
    preview: { port: Number(process.env.PREVIEW_PORT ?? 4031), strictPort: true },
  };
});
