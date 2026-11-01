import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { loadConfig, log, ReceiptSigner, seedStore, simulationScope, Store, type PenstockConfig } from "@penstock/core";
import { HttpError, sendJson, sendRaw } from "./http";
import { ExactNearMethod, httpExactFacilitator, simulatedExactFacilitator, type ExactFacilitator } from "./methods/exact-near";
import type { PaymentMethodHandler } from "./methods/types";
import { forwardDelivery, handleHttpPaid, handleMcpPaid, PAID_CORS_HEADERS, type ProxyContext } from "./paywall";
import { DEFAULT_LIMITS, RateLimiter } from "./ratelimit";

export interface ProxyOptions {
  config?: PenstockConfig;
  store?: Store;
  upstreamBase?: string;
  receipts?: ReceiptSigner;
  exactFacilitator?: ExactFacilitator;
  /** Replace the payment methods entirely (tests). */
  methods?: PaymentMethodHandler[];
  now?: () => number;
}

export interface Proxy {
  server: Server;
  store: Store;
  config: PenstockConfig;
  ctx: ProxyContext;
}

const PAID_ROUTE = /^\/p\/([a-z0-9][a-z0-9-]{0,39})\/([a-z0-9][a-z0-9-]{0,59})(\/[^?#]*)?$/;

function buildMethods(config: PenstockConfig, opts: ProxyOptions): PaymentMethodHandler[] {
  if (opts.methods) return opts.methods;
  let exact: ExactFacilitator;
  let exactSimulated: boolean;
  if (opts.exactFacilitator) {
    exact = opts.exactFacilitator;
    exactSimulated = config.mode !== "live";
  } else if (config.mode === "live") {
    if (!config.facilitatorUrl) throw new Error("FACILITATOR_URL is required in live mode for the exact NEAR scheme");
    exact = httpExactFacilitator(config.facilitatorUrl, config.facilitatorApiKey);
    exactSimulated = false;
  } else {
    exact = simulatedExactFacilitator();
    exactSimulated = true;
  }
  return [new ExactNearMethod(exact, exactSimulated)];
}

export function createProxy(opts: ProxyOptions = {}): Proxy {
  const config = opts.config ?? loadConfig();
  const store = opts.store ?? new Store(join(config.dataDir, `penstock-${config.mode}.sqlite`));
  if (config.mode !== "live") {
    seedStore(store, { origin: config.publicUrl, upstream: opts.upstreamBase ?? "http://127.0.0.1:4030", homeNearAccount: config.sellerNearAccount });
  }
  const ctx: ProxyContext = {
    config,
    store,
    methods: buildMethods(config, opts),
    receipts: opts.receipts ?? (opts.store ? ReceiptSigner.ephemeral() : ReceiptSigner.fromDir(config.dataDir)),
    limiter: new RateLimiter(DEFAULT_LIMITS),
    allowPrivateUpstreams: config.allowPrivateUpstreams,
    trustProxy: config.trustProxy,
    delivery: forwardDelivery,
    now: opts.now ?? Date.now,
  };

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://penstock.local");
    const path = url.pathname;

    if (path === "/healthz") {
      return sendJson(res, 200, { ok: true, mode: config.mode, simulation: simulationScope(config.mode) });
    }

    const paid = PAID_ROUTE.exec(path);
    if (paid) {
      if (req.method === "OPTIONS") return sendRaw(res, 204, "", { ...PAID_CORS_HEADERS, "access-control-max-age": "600" });
      const seller = store.getSeller(paid[1]!);
      const endpoint = seller ? store.findEndpoint(seller.id, paid[2]!) : undefined;
      if (!seller || !endpoint) throw new HttpError(404, "no such paid endpoint", "not_found");
      if (endpoint.kind === "mcp") return handleMcpPaid(ctx, req, res, seller, endpoint);
      return handleHttpPaid(ctx, req, res, seller, endpoint, paid[3] ?? "", url.search);
    }

    throw new HttpError(404, "not found", "not_found");
  };

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
      log("error", "unhandled request error", { path: (req.url ?? "").split("?")[0], error: (e as Error).message });
      sendJson(res, 500, { error: "internal error" });
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  return { server, store, config, ctx };
}
