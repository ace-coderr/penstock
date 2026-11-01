import { CHAINS, HOME_SELLER_ID, ReceiptSigner, Store, parseUnits, type Payment } from "@penstock/core";
import { PRIVACY_SCOPE } from "@penstock/shielded";
import type { Snapshot } from "../src/static/snapshot";

/**
 * Builds the hosted demo snapshot from a seeded ledger. Only the home seller's rows are kept
 * (the console shows one seller). Receipts use the same body shape the proxy's admin API
 * issues for seeded history.
 */
export function buildSnapshot(store: Store, opts: { origin: string; now?: number; signer?: ReceiptSigner }): Snapshot {
  const now = opts.now ?? Date.now();
  const signer = opts.signer ?? ReceiptSigner.ephemeral();
  const seller = store.getSeller(HOME_SELLER_ID)!;
  const endpoints = store.listEndpoints(HOME_SELLER_ID);
  const payments: Payment[] = store.listPayments({ sellerId: HOME_SELLER_ID, limit: 5000 });
  const receipts: Snapshot["receipts"] = {};
  for (const p of payments) {
    receipts[p.id] = signer.sign({
      v: 1, kind: p.sessionId ? "session-funding" : "payment", paymentId: p.id, ...(p.sessionId ? { sessionId: p.sessionId } : {}), seller: seller.nearAccount, endpoint: p.endpointId,
      amountUsdc: p.amountOut, network: "near:mainnet", transaction: p.destTx ?? "", originChain: p.originChain, originTx: p.originTx, payer: p.payer, ts: p.ts,
      status: p.status, simulated: true, note: "issued from seeded demo history",
    });
  }
  return {
    version: 1,
    generatedAt: now,
    origin: opts.origin,
    seller,
    sellers: store.listSellers(),
    endpoints,
    payments,
    probes: store.listProbes({ endpointIds: endpoints.map((e) => e.id), limit: 20000 }).map(({ simulated: _s, ...p }) => p),
    sessions: store.listSessions(HOME_SELLER_ID, 5000),
    receipts,
    chains: CHAINS.map((c) => ({
      key: c.key, label: c.label, tag: c.tag, color: c.color, routeMinimumUsdc: c.routeMinimumUsdc,
      assets: c.assets.map((a) => ({ symbol: a.symbol, decimals: a.decimals, x402Asset: a.x402Asset, refPriceUsd: a.refPriceUsd, stable: a.stable })),
    })),
    capUsdc: parseUnits("5", 6).toString(),
    shielded: {
      active: null,
      routes: [
        { id: "confidential-intents", label: "Confidential Intents (NEAR Intents)", enabled: false, reason: "Not enabled in the hosted demo. Run locally with `pnpm demo --shielded` to see it enabled (simulated)." },
        { id: "aurora", label: "Aurora private chain", enabled: false, reason: "Not enabled. Set SHIELDED_AURORA_RPC_URL to an Aurora Cloud private chain RPC when running locally." },
      ],
      scope: PRIVACY_SCOPE,
    },
  };
}
