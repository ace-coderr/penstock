import { CHAINS, DESTINATION, formatUnits, parseUnits, simulationScope } from "@penstock/core";
import { NEAR_INTENTS_SPEC_SOURCE, NEAR_INTENTS_SPEC_VERSION, ONECLICK_API_DOCS, ONECLICK_API_VERSION } from "@penstock/intents-adapter";
import type { ProxyContext } from "./paywall";

/**
 * `/.well-known/penstock.json`: what this Penstock instance sells, at what price, and which chains
 * and assets it accepts. Agents use it to find sellers by capability and price before calling.
 */
export function discoveryDocument(ctx: ProxyContext, sellerId?: string) {
  const base = ctx.config.publicUrl;
  const sellers = ctx.store.listSellers().filter((s) => !sellerId || s.id === sellerId);
  const scope = simulationScope(ctx.config.mode);
  return {
    penstock: "1",
    x402Version: 2,
    mode: ctx.config.mode,
    simulated: scope.settlement,
    simulation: scope.label,
    generatedAt: new Date(ctx.now()).toISOString(),
    destination: { network: DESTINATION.network, asset: DESTINATION.asset, symbol: DESTINATION.symbol, description: "Sellers receive USDC on NEAR" },
    paymentMethods: [
      { id: "exact-near", scheme: "exact", network: DESTINATION.network, spec: "x402 exact on NEAR (@x402/near)", note: "Pay USDC on NEAR directly to the seller with a signed NEP-366 delegate action." },
      { id: "near-intents", scheme: "exact", assetTransferMethod: "near-intents", spec: NEAR_INTENTS_SPEC_VERSION, specSource: NEAR_INTENTS_SPEC_SOURCE, settlement: { api: "1Click Swap API", version: ONECLICK_API_VERSION, docs: ONECLICK_API_DOCS }, note: "Pay any listed asset on any listed chain; NEAR Intents (1Click) delivers USDC to the seller." },
    ],
    acceptedOrigins: CHAINS.map((c) => ({ chain: c.key, network: c.caip2, label: c.label, assets: c.assets.map((a) => ({ symbol: a.symbol, asset: a.x402Asset, decimals: a.decimals })) })),
    sessions: { capUsdc: parseUnits(ctx.config.sessionCapUsd, 6).toString(), note: "One payment funds a metered session; unused balance is refunded on close." },
    routes: `${base}/api/public/routes?endpoint={endpointId}&from={chain}:{symbol}[:{balance}],...`,
    sellers: sellers.map((s) => ({
      id: s.id,
      name: s.name,
      nearAccount: s.nearAccount,
      description: s.description,
      endpoints: ctx.store.listEndpoints(s.id).map((e) => ({
        id: e.id,
        url: `${base}/p/${s.id}/${e.slug}`,
        kind: e.kind,
        description: e.description,
        capabilities: e.capabilities,
        priceUsdc: e.priceUsdc,
        priceUsd: formatUnits(e.priceUsdc, 6),
        methods: e.methods,
        sessions: e.sessionsEnabled ? { open: `${base}/s/${s.id}/${e.slug}/open/{amountUsdc}`, status: `${base}/s/${s.id}/${e.slug}/status`, close: `${base}/s/${s.id}/${e.slug}/close` } : null,
        resale: e.resaleOf.length > 0,
      })),
    })),
  };
}
