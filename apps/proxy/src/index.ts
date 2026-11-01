import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { loadConfig, seedStore, simulationScope, Store, type PenstockConfig } from "@penstock/core";

export interface ProxyOptions {
  config?: PenstockConfig;
  store?: Store;
  upstreamBase?: string;
}

export function createProxy(opts: ProxyOptions = {}): { server: Server; store: Store; config: PenstockConfig } {
  const config = opts.config ?? loadConfig();
  const store = opts.store ?? new Store(join(config.dataDir, `penstock-${config.mode}.sqlite`));
  if (config.mode !== "live") {
    seedStore(store, { origin: config.publicUrl, upstream: opts.upstreamBase ?? "http://127.0.0.1:4030", homeNearAccount: config.sellerNearAccount });
  }
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: config.mode, simulation: simulationScope(config.mode) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return { server, store, config };
}
