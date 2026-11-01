import type { IncomingMessage, ServerResponse } from "node:http";
import { HOME_SELLER_ID } from "@penstock/core";
import type { Holding, IntentsStack } from "@penstock/intents-adapter";
import type { AccountChecker } from "./account-check";
import { overview } from "./admin-api";
import { clientAddress, HttpError, sendJson } from "./http";
import { PAID_CORS_HEADERS, type ProxyContext } from "./paywall";

/**
 * Unauthenticated read-only endpoints for buyers and agents:
 *   GET /api/public/routes?endpoint=<seller>.<slug>&from=base:USDC,sol:SOL[:balance]
 *     ranks every route from the buyer's holdings to USDC on NEAR (quote, fee, time).
 *   GET /api/public/stats
 *     headline numbers for the landing page, published only for simulated demo/dry data.
 */
export async function handlePublicApi(ctx: ProxyContext, intents: IntentsStack, accounts: AccountChecker, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== "GET") throw new HttpError(405, "GET only", "method_not_allowed");
  if (url.pathname === "/api/public/stats") {
    // A live seller's revenue is not published here; the landing page only shows simulated demo data.
    if (ctx.config.mode === "live") throw new HttpError(404, "stats are only published for simulated demo data", "not_found");
    if (ctx.limiter.take("request", clientAddress(req, ctx.trustProxy), ctx.now())) throw new HttpError(429, "rate limited", "rate_limited");
    const o = overview(ctx, HOME_SELLER_ID, 30);
    return sendJson(res, 200, {
      simulated: true, days: o.days, seller: ctx.store.getSeller(HOME_SELLER_ID)?.name ?? HOME_SELLER_ID,
      payments: o.payments, chains: o.byChain.length, receivedUsdc: o.receivedUsdc, conversion: o.conversion, probes: o.probes,
    }, { ...PAID_CORS_HEADERS, "cache-control": "public, max-age=30" });
  }
  if (ctx.limiter.take("routes", clientAddress(req, ctx.trustProxy), ctx.now())) throw new HttpError(429, "rate limited: route quotes are limited per client", "rate_limited");

  if (url.pathname === "/api/public/routes") {
    const id = url.searchParams.get("endpoint") ?? `${HOME_SELLER_ID}.tides`;
    const endpoint = ctx.store.getEndpoint(id);
    if (!endpoint) throw new HttpError(404, "unknown endpoint", "not_found");
    const seller = ctx.store.getSeller(endpoint.sellerId)!;
    const from = (url.searchParams.get("from") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 24);
    const holdings: Holding[] = from.map((f) => {
      const [chain, symbol, balance] = f.split(":");
      return { chain: chain ?? "", symbol: symbol ?? "", ...(balance && /^\d{1,40}$/.test(balance) ? { balance } : {}) };
    });
    const account = await accounts.check(seller.nearAccount);
    if (account.exists === false) {
      // 1Click would answer every quote with an opaque 400; say what is actually wrong.
      return sendJson(res, 409, { endpoint: endpoint.id, error: account.message, account }, PAID_CORS_HEADERS);
    }
    const routes = await intents.planner.rank(holdings, BigInt(endpoint.priceUsdc), seller.nearAccount);
    return sendJson(res, 200, {
      endpoint: endpoint.id, priceUsdc: endpoint.priceUsdc, recipient: seller.nearAccount, destination: "USDC on NEAR",
      quoteSource: intents.planner.source, simulated: intents.oneClick.kind === "simulated",
      cheapest: routes.find((r) => !r.error && r.affordable !== false) ?? null,
      routes: routes.map((r) => ({ ...r, amountInUsd: Number.isFinite(r.amountInUsd) ? r.amountInUsd : null })),
    }, PAID_CORS_HEADERS);
  }
  throw new HttpError(404, "not found", "not_found");
}
