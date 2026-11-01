import { CHAINS, chainByKey, type AssetInfo, type ChainInfo } from "./chains";
import { sha256Hex } from "./crypto";
import type { Store } from "./store";
import type { Endpoint, Payment, Probe, Seller, Session } from "./types";

/**
 * Deterministic demo data. Every row written here is flagged `simulated` and every identifier
 * that would be an on-chain value carries a `sim` prefix, so nothing can be mistaken for a real
 * transaction.
 */

export const HOME_SELLER_ID = "tidewater";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedOptions {
  /** Base URL of this Penstock proxy (sellers' origin). */
  origin: string;
  /** Base URL of the example upstream APIs. */
  upstream: string;
  homeNearAccount?: string;
  now?: number;
  seed?: number;
}

export function seedSellers(o: SeedOptions): { sellers: Seller[]; endpoints: Endpoint[] } {
  const sellers: Seller[] = [
    { id: HOME_SELLER_ID, name: "Tidewater Data", nearAccount: o.homeNearAccount ?? "tidewater-data.near", description: "Tide tables, marine conditions and harbour briefings for routing agents.", origin: o.origin, simulated: true },
    { id: "northwind", name: "Northwind Weather", nearAccount: "northwind-wx.near", description: "Marine and coastal weather nowcasts.", origin: o.origin, simulated: true },
    { id: "quillfeed", name: "Quillfeed", nearAccount: "quillfeed.near", description: "Short-text translation tuned for logistics and shipping notices.", origin: o.origin, simulated: true },
    { id: "ferrous", name: "Ferrous Filings", nearAccount: "ferrous-filings.near", description: "Structured extracts from public company filings.", origin: o.origin, simulated: true },
    { id: "pixelwright", name: "Pixelwright", nearAccount: "pixelwright.near", description: "Image captions and alt text.", origin: o.origin, simulated: true },
  ];
  const ep = (sellerId: string, slug: string, x: Partial<Endpoint> & Pick<Endpoint, "description" | "priceUsdc" | "upstreamUrl" | "capabilities">): Endpoint => ({
    id: `${sellerId}.${slug}`, sellerId, slug, kind: "http", methods: ["GET", "POST"], sessionsEnabled: false, resaleOf: [], ...x,
  });
  const endpoints: Endpoint[] = [
    ep(HOME_SELLER_ID, "tides", { description: "Tide predictions for a harbour: next highs and lows, heights in metres.", priceUsdc: "4000", upstreamUrl: `${o.upstream}/tides`, capabilities: ["tides", "marine", "forecast"], sessionsEnabled: true, methods: ["GET"] }),
    ep(HOME_SELLER_ID, "geocode", { description: "Harbour name to coordinates and UN/LOCODE.", priceUsdc: "2000", upstreamUrl: `${o.upstream}/geocode`, capabilities: ["geocode", "ports"], sessionsEnabled: true, methods: ["GET"] }),
    ep(HOME_SELLER_ID, "summarize", { kind: "mcp", description: "MCP tool: summarise a notice to mariners into three lines.", priceUsdc: "10000", upstreamUrl: `${o.upstream}/mcp`, capabilities: ["summarize", "text", "mcp"], methods: ["POST"] }),
    ep(HOME_SELLER_ID, "harbor-brief", {
      description: "Harbour briefing: tides plus marine weather plus a translated notice. Resold from two Penstock sellers.",
      priceUsdc: "25000", upstreamUrl: `${o.upstream}/brief`, capabilities: ["briefing", "marine", "translate"], methods: ["GET"],
      resaleOf: [`${o.origin}/p/northwind/marine-weather`, `${o.origin}/p/quillfeed/translate`],
    }),
    ep("northwind", "marine-weather", { description: "Wind, swell and visibility nowcast for a coordinate.", priceUsdc: "6000", upstreamUrl: `${o.upstream}/weather`, capabilities: ["weather", "marine", "forecast"], methods: ["GET"] }),
    ep("quillfeed", "translate", { description: "Translate up to 500 characters.", priceUsdc: "8000", upstreamUrl: `${o.upstream}/translate`, capabilities: ["translate", "text"], methods: ["GET", "POST"] }),
    ep("ferrous", "filing-extract", { description: "Key figures from a public filing by ticker.", priceUsdc: "20000", upstreamUrl: `${o.upstream}/filing`, capabilities: ["finance", "filings", "extract"], methods: ["GET"] }),
    ep("pixelwright", "caption", { description: "One-sentence caption for an image URL.", priceUsdc: "15000", upstreamUrl: `${o.upstream}/caption`, capabilities: ["vision", "caption"], methods: ["POST"] }),
  ];
  return { sellers, endpoints };
}

const CHAIN_WEIGHTS: [string, number][] = [
  ["near", 0.2], ["base", 0.18], ["arb", 0.15], ["sol", 0.14], ["eth", 0.1], ["op", 0.07], ["pol", 0.06], ["btc", 0.05], ["avax", 0.05],
];

function pick<T>(rnd: () => number, weighted: [T, number][]): T {
  const total = weighted.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [v, w] of weighted) {
    if ((r -= w) <= 0) return v;
  }
  return weighted[weighted.length - 1]![0];
}

function simHex(rnd: () => number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += Math.floor(rnd() * 16).toString(16);
  return out;
}

function simAddress(chain: ChainInfo, rnd: () => number): string {
  if (chain.key === "near") return `sim-${simHex(rnd, 8)}.near`;
  if (chain.key === "sol") return `sim${simHex(rnd, 40)}`;
  if (chain.key === "btc") return `sim-bc1q${simHex(rnd, 34)}`;
  return `sim:0x${simHex(rnd, 40)}`;
}

function simTx(chain: ChainInfo, rnd: () => number): string {
  return chain.key === "sol" || chain.key === "near" ? `sim:${simHex(rnd, 44)}` : `sim:0x${simHex(rnd, 64)}`;
}

/** Fee model for simulated routes, as a fraction of the delivered amount. */
export function simulatedFeeFraction(chain: ChainInfo, asset: AssetInfo, rnd: () => number): number {
  if (chain.key === "near" && asset.symbol === "USDC") return 0;
  const base = asset.stable ? 0.003 : 0.006;
  const chainExtra = chain.key === "btc" ? 0.012 : chain.key === "eth" ? 0.004 : 0.001;
  return base + chainExtra + rnd() * 0.004;
}

const DROP_REASONS = {
  probed: [
    "Left after seeing the price: no quote requested",
    "No asset the buyer holds is accepted here",
    "Retried without a payment header, then stopped",
  ],
  quoted: [
    "Quote expired before a deposit arrived",
    "Route fee above 3% of the price: likely judged too expensive",
    "Requested quotes on several chains, paid none",
  ],
  deposited: ["Deposit below the quoted minimum: refunded to payer"],
} as const;

export interface SeedSummary {
  sellers: number;
  endpoints: number;
  payments: number;
  probes: number;
  sessions: number;
}

/** Writes sellers, endpoints and ~30 days of simulated history. Idempotent per store. */
export function seedStore(store: Store, o: SeedOptions): SeedSummary {
  const { sellers, endpoints } = seedSellers(o);
  for (const x of sellers) store.upsertSeller(x);
  for (const e of endpoints) store.upsertEndpoint(e);
  if (store.getKv("seeded") === "1") {
    return { sellers: sellers.length, endpoints: endpoints.length, payments: store.countPayments(), probes: store.listProbes({ limit: 20000 }).length, sessions: store.listSessions(undefined, 10000).length };
  }

  const rnd = mulberry32(o.seed ?? 1402);
  const now = o.now ?? Date.now();
  const day = 86_400_000;
  const buyers = Array.from({ length: 150 }, (_, i) => "b_" + sha256Hex(`seed-buyer-${i}`).slice(0, 12));
  const homeEndpoints = endpoints.filter((e) => e.sellerId === HOME_SELLER_ID);
  const endpointWeights: [Endpoint, number][] = homeEndpoints.map((e) => [e, e.slug === "tides" ? 0.45 : e.slug === "geocode" ? 0.25 : e.slug === "summarize" ? 0.15 : 0.15]);
  const otherEndpoints = endpoints.filter((e) => e.sellerId !== HOME_SELLER_ID);

  let payments = 0;
  let probes = 0;
  let sessions = 0;
  let pid = 0;

  const writePayment = (endpoint: Endpoint, ts: number, buyer: string, opts: { method?: Payment["method"]; amountOut?: bigint; sessionId?: string; status?: Payment["status"] } = {}): Payment => {
    const chain = chainByKey(pick(rnd, CHAIN_WEIGHTS))!;
    const asset = chain.assets[rnd() < 0.7 ? 0 : Math.min(chain.assets.length - 1, 1 + Math.floor(rnd() * (chain.assets.length - 1)))]!;
    const method: Payment["method"] = opts.method ?? (chain.key === "near" && asset.symbol === "USDC" ? "exact-near" : "near-intents");
    const amountOut = opts.amountOut ?? BigInt(endpoint.priceUsdc);
    const outUsd = Number(amountOut) / 1e6;
    const fee = method === "exact-near" ? 0 : simulatedFeeFraction(chain, asset, rnd);
    const inUsd = outUsd * (1 + fee);
    const amountIn = BigInt(Math.max(1, Math.round((inUsd / asset.refPriceUsd) * 10 ** Math.min(asset.decimals, 15)))) * 10n ** BigInt(Math.max(0, asset.decimals - 15));
    const roll = rnd();
    const status: Payment["status"] = opts.status ?? (ts > now - 90_000 ? "pending" : roll < 0.035 ? "refunded" : roll < 0.045 ? "failed" : "settled");
    const p: Payment = {
      id: `pay_${(++pid).toString().padStart(5, "0")}`, ts, sellerId: endpoint.sellerId, endpointId: endpoint.id, method, status,
      originChain: chain.key, originAsset: asset.x402Asset, originSymbol: asset.symbol, amountIn: amountIn.toString(),
      amountInUsd: Number(inUsd.toFixed(6)), amountOut: amountOut.toString(), feeUsd: Number((inUsd - outUsd).toFixed(6)),
      payer: simAddress(chain, rnd), refundTo: "", depositAddress: method === "near-intents" ? simAddress(chain, rnd) : null,
      originTx: simTx(chain, rnd), destTx: status === "settled" ? simTx(chainByKey("near")!, rnd) : null,
      refundedAmount: status === "refunded" ? amountIn.toString() : null,
      refundReason: status === "refunded" ? (rnd() < 0.6 ? "PARTIAL_DEPOSIT" : "DEADLINE_PASSED") : status === "failed" ? "ROUTE_FAILED" : null,
      operationId: method === "near-intents" ? `sim:${chain.caip2}:${simHex(rnd, 16)}` : null, sessionId: opts.sessionId ?? null,
      upstreamCost: endpoint.resaleOf.length ? "14000" : "0", shielded: rnd() < 0.06 && method === "near-intents", simulated: true, receiptSig: null,
    };
    p.refundTo = p.payer;
    store.insertPayment(p);
    payments++;
    return p;
  };

  const writeProbe = (endpoint: Endpoint, ts: number, buyer: string, stage: Probe["stage"], reason: string | null, chain: string | null, paymentId: string | null) => {
    store.insertProbe({ id: `prb_${(++probes).toString().padStart(5, "0")}`, ts, endpointId: endpoint.id, buyer, originChain: chain, stage, inferredReason: reason, paymentId, simulated: true });
  };

  store.tx(() => {
    // Paid calls on the home seller, growing over 30 days.
    for (let i = 0; i < 430; i++) {
      const age = Math.pow(rnd(), 0.8) * 30 * day;
      const ts = Math.round(now - age);
      const endpoint = pick(rnd, endpointWeights);
      const buyer = buyers[Math.floor(Math.pow(rnd(), 1.6) * buyers.length)]!;
      const p = writePayment(endpoint, ts, buyer);
      writeProbe(endpoint, ts - 4000, buyer, p.status === "refunded" ? "refunded" : p.status === "settled" ? "paid" : "deposited",
        p.status === "refunded" ? DROP_REASONS.deposited[0] : null, p.originChain, p.id);
    }
    // Sessions: one funding payment each, metered calls, most closed with a refund.
    for (let i = 0; i < 24; i++) {
      const endpoint = homeEndpoints[rnd() < 0.7 ? 0 : 1]!;
      const closed = rnd() < 0.8;
      // Open sessions are recent (sessions expire after 24h and are then closed and refunded).
      const ts = Math.round(now - (closed ? rnd() * 28 * day : rnd() * 20 * 3_600_000));
      const buyer = buyers[Math.floor(rnd() * 40)]!;
      const funded = BigInt([1, 2, 2, 3, 5][Math.floor(rnd() * 5)]! * 1_000_000);
      const sid = `ses_${(++sessions).toString().padStart(4, "0")}`;
      const fund = writePayment(endpoint, ts, buyer, { amountOut: funded, sessionId: sid, status: "settled" });
      const price = BigInt(endpoint.priceUsdc);
      const maxCalls = Number(funded / price);
      const calls = Math.floor(maxCalls * (0.2 + rnd() * 0.75));
      const spent = price * BigInt(calls);
      const session: Session = {
        id: sid, sellerId: HOME_SELLER_ID, endpointId: endpoint.id, buyer, capUsdc: "5000000", fundedUsdc: funded.toString(),
        spentUsdc: spent.toString(), settledUsdc: closed ? spent.toString() : (spent - (spent % (price * 50n))).toString(), status: closed ? "closed" : "open",
        openedAt: ts, closedAt: closed ? ts + Math.round(rnd() * 6 * 3_600_000) : null, refundUsdc: closed ? (funded - spent).toString() : null,
        fundingPaymentId: fund.id, refundTo: fund.payer, originChain: fund.originChain, simulated: true,
      };
      store.insertSession(session, sha256Hex(`seed-session-secret-${sid}`));
      store.setSessionExpiry(sid, ts + 86_400_000);
      if (closed) store.setSessionRefund(sid, "simulated", simTx(chainByKey("near")!, rnd));
      writeProbe(endpoint, ts - 3000, buyer, "paid", null, fund.originChain, fund.id);
    }
    // Drop-offs: probes that never became payments. Reasons are inferred from behaviour.
    for (let i = 0; i < 640; i++) {
      const endpoint = pick(rnd, endpointWeights);
      const ts = Math.round(now - rnd() * 30 * day);
      const buyer = buyers[Math.floor(rnd() * buyers.length)]!;
      const stage: Probe["stage"] = rnd() < 0.62 ? "probed" : "quoted";
      const reasons = DROP_REASONS[stage === "probed" ? "probed" : "quoted"];
      const chain = stage === "quoted" ? pick(rnd, CHAIN_WEIGHTS) : null;
      writeProbe(endpoint, ts, buyer, stage, reasons[Math.floor(rnd() * reasons.length)]!, chain, null);
    }
    // Other sellers: enough history to rank in discovery.
    for (let i = 0; i < 120; i++) {
      const endpoint = otherEndpoints[Math.floor(rnd() * otherEndpoints.length)]!;
      const ts = Math.round(now - rnd() * 30 * day);
      const buyer = buyers[Math.floor(rnd() * buyers.length)]!;
      const p = writePayment(endpoint, ts, buyer, { status: "settled" });
      writeProbe(endpoint, ts - 2000, buyer, "paid", null, p.originChain, p.id);
    }
    store.setKv("seeded", "1");
  });

  return { sellers: sellers.length, endpoints: endpoints.length, payments, probes, sessions };
}

export { CHAINS };
