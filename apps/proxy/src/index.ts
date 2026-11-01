import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { loadConfig, log, ReceiptSigner, seedStore, simulationScope, Store, type PaymentMethodHandler, type PenstockConfig } from "@penstock/core";
import { createIntentsStack, type IntentsStack, type OneClick } from "@penstock/intents-adapter";
import { clientAddress, HttpError, readJson, sendJson, sendRaw } from "./http";
import { ExactNearMethod, httpExactFacilitator, simulatedExactFacilitator, type ExactFacilitator } from "./methods/exact-near";
import { forwardDelivery, handleHttpPaid, handleMcpPaid, PAID_CORS_HEADERS, type ProxyContext } from "./paywall";
import { DEFAULT_LIMITS, RateLimiter } from "./ratelimit";
import { handlePublicApi } from "./public-api";
import { SessionManager } from "./sessions";
import { discoveryDocument } from "./discovery";
import { AccountChecker } from "./account-check";
import { handleAdminApi } from "./admin-api";

export interface ProxyOptions {
  config?: PenstockConfig;
  store?: Store;
  upstreamBase?: string;
  receipts?: ReceiptSigner;
  exactFacilitator?: ExactFacilitator;
  oneClick?: OneClick;
  /** Replace the payment methods entirely (tests). */
  methods?: PaymentMethodHandler[];
  now?: () => number;
}

export interface Proxy {
  server: Server;
  store: Store;
  config: PenstockConfig;
  ctx: ProxyContext;
  intents: IntentsStack;
  sessions: SessionManager;
  accounts: AccountChecker;
}

const SESSION_ROUTE = /^\/s\/([a-z0-9][a-z0-9-]{0,39})\/([a-z0-9][a-z0-9-]{0,59})\/(open|status|close)(?:\/([0-9]{1,12}))?$/;
const PAID_ROUTE = /^\/p\/([a-z0-9][a-z0-9-]{0,39})\/([a-z0-9][a-z0-9-]{0,59})(\/[^?#]*)?$/;

function buildExact(config: PenstockConfig, opts: ProxyOptions): ExactNearMethod {
  if (opts.exactFacilitator) return new ExactNearMethod(opts.exactFacilitator, config.mode !== "live");
  if (config.mode === "live") {
    if (!config.facilitatorUrl) throw new Error("FACILITATOR_URL is required in live mode for the exact NEAR scheme");
    return new ExactNearMethod(httpExactFacilitator(config.facilitatorUrl, config.facilitatorApiKey), false);
  }
  return new ExactNearMethod(simulatedExactFacilitator(), true);
}

export function createProxy(opts: ProxyOptions = {}): Proxy {
  const config = opts.config ?? loadConfig();
  const store = opts.store ?? new Store(join(config.dataDir, `penstock-${config.mode}.sqlite`));
  if (config.mode !== "live") {
    seedStore(store, { origin: config.publicUrl, upstream: opts.upstreamBase ?? "http://127.0.0.1:4030", homeNearAccount: config.sellerNearAccount });
  }
  const accounts = new AccountChecker(config.mode, store);
  const intents = createIntentsStack(config, {
    oneClick: opts.oneClick,
    recipientCheck: async (account) => {
      const r = await accounts.check(account);
      return { ok: r.exists !== false, message: r.message };
    },
  });
  const ctx: ProxyContext = {
    config,
    store,
    methods: opts.methods ?? [buildExact(config, opts), intents.method],
    receipts: opts.receipts ?? (opts.store ? ReceiptSigner.ephemeral() : ReceiptSigner.fromDir(config.dataDir)),
    limiter: new RateLimiter(DEFAULT_LIMITS),
    allowPrivateUpstreams: config.allowPrivateUpstreams,
    trustProxy: config.trustProxy,
    delivery: forwardDelivery,
    now: opts.now ?? Date.now,
  };
  const sessions = new SessionManager(ctx);
  ctx.sessions = sessions;

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://penstock.local");
    const path = url.pathname;

    if (path === "/healthz") {
      return sendJson(res, 200, { ok: true, mode: config.mode, simulation: simulationScope(config.mode) });
    }

    if (path === "/.well-known/penstock.json") {
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "GET only", "method_not_allowed");
      const seller = url.searchParams.get("seller") ?? undefined;
      return sendJson(res, 200, discoveryDocument(ctx, seller && /^[a-z0-9-]{1,40}$/.test(seller) ? seller : undefined), { ...PAID_CORS_HEADERS, "cache-control": "public, max-age=60" });
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

    const sess = SESSION_ROUTE.exec(path);
    if (sess) {
      const seller = store.getSeller(sess[1]!);
      const endpoint = seller ? store.findEndpoint(seller.id, sess[2]!) : undefined;
      if (!seller || !endpoint) throw new HttpError(404, "no such paid endpoint", "not_found");
      return sessions.handle(req, res, seller, endpoint, sess[3]!, sess[4], url);
    }

    // Simulated origin-chain transfer into a simulated deposit address (demo and dry mode only).
    if (path === "/sim/deposit" && req.method === "POST") {
      if (config.mode === "live" || !intents.sim) throw new HttpError(404, "not found", "not_found");
      if (ctx.limiter.take("request", clientAddress(req, ctx.trustProxy), ctx.now())) throw new HttpError(429, "rate limited", "rate_limited");
      const body = await readJson<{ depositAddress?: string; amount?: string }>(req, 4096);
      if (typeof body.depositAddress !== "string" || typeof body.amount !== "string" || !body.depositAddress.startsWith("sim")) {
        throw new HttpError(400, "depositAddress (sim…) and amount (base units) are required", "invalid_request");
      }
      try {
        const txHash = intents.sim.deposit(body.depositAddress, body.amount);
        return sendJson(res, 200, { txHash, simulated: true }, PAID_CORS_HEADERS);
      } catch (e) {
        throw new HttpError((e as { status?: number }).status ?? 400, (e as Error).message, "deposit_rejected");
      }
    }

    if (path.startsWith("/api/public/")) return handlePublicApi(ctx, intents, accounts, req, res, url);
    if (path.startsWith("/api/admin/")) return handleAdminApi(ctx, accounts, req, res, url);

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
  server.on("listening", () => sessions.start());
  server.on("close", () => sessions.stop());
  return { server, store, config, ctx, intents, sessions, accounts };
}
