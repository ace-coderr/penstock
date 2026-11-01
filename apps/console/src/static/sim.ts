import { ApiError } from "../api";
import type { Payment, Receipt } from "../types";
import { accountCheck, endpointsView, exportCsv, funnel, HOSTED_LABEL, listPayments, overview, rebase, sessionsView, stats } from "./compute";
import type { Snapshot, SnapshotChain, SnapshotEndpoint } from "./snapshot";

/**
 * The hosted demo's API, running in the browser. It answers the same paths with the same shapes
 * as the proxy's admin API, from the build-time snapshot plus a simulated agent that "pays" every
 * few seconds. It makes no network request except fetching /demo-snapshot.json from this origin.
 */

let state: Promise<Snapshot> | null = null;
let agentStarted = false;
let counter = 0;

function hex(n: number): string {
  const b = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, n);
}

async function load(): Promise<Snapshot> {
  if (!state) {
    state = fetch("/demo-snapshot.json", { credentials: "omit" })
      .then((r) => {
        if (!r.ok) throw new ApiError(0, "The hosted demo data could not be loaded.");
        return r.json() as Promise<Snapshot>;
      })
      .then((s) => rebase(s, Date.now()));
  }
  return state;
}

/** One simulated agent payment, following the same rules as the real flow (bridge minimums, fees). */
function agentPayment(s: Snapshot): void {
  const pool: [string, string][] = [["near", "USDC"], ["op", "USDC"], ["arb", "USDC"], ["base", "USDC"], ["sol", "SOL"], ["near", "wNEAR"], ["pol", "USDC"], ["eth", "ETH"], ["avax", "USDC"]];
  const targets = ["tides", "voyage-plan", "geocode", "harbor-brief", "tides", "summarize"];
  const n = counter++;
  const ep: SnapshotEndpoint = s.endpoints.find((e) => e.slug === targets[n % targets.length]) ?? s.endpoints[0]!;
  const price = BigInt(ep.priceUsdc);
  // Pick a holding whose route can carry this price per call (as the real buyer does).
  let chain: SnapshotChain | undefined;
  let symbol = "USDC";
  for (let k = 0; k < pool.length; k++) {
    const [c, sym] = pool[(n + k) % pool.length]!;
    const info = s.chains.find((x) => x.key === c);
    if (info && BigInt(info.routeMinimumUsdc) <= price) {
      chain = info;
      symbol = sym;
      break;
    }
  }
  chain = chain ?? s.chains.find((x) => x.key === "near")!;
  const asset = chain.assets.find((a) => a.symbol === symbol) ?? chain.assets[0]!;
  const exact = chain.key === "near" && asset.symbol === "USDC";
  const outUsd = Number(price) / 1e6;
  const feeFrac = exact ? 0 : (asset.stable ? 0.0035 : 0.007) + (chain.key === "eth" ? 0.004 : 0.001);
  const inUsd = outUsd * (1 + feeFrac);
  const amountIn = BigInt(Math.max(1, Math.round((inUsd / asset.refPriceUsd) * 10 ** Math.min(asset.decimals, 15)))) * 10n ** BigInt(Math.max(0, asset.decimals - 15));
  const refunded = !exact && n % 17 === 16;
  const ts = Date.now();
  const id = `pay_web${String(n).padStart(4, "0")}`;
  const payer = chain.key === "near" ? `sim-agent-${n % 7}.near` : `sim:0x${hex(40)}`;
  const p: Payment = {
    id, ts, endpointId: ep.id, method: exact ? "exact-near" : "near-intents", status: refunded ? "refunded" : "settled",
    originChain: chain.key, originAsset: asset.x402Asset, originSymbol: asset.symbol, amountIn: amountIn.toString(), amountInUsd: Number(inUsd.toFixed(6)),
    amountOut: price.toString(), feeUsd: Number((inUsd - outUsd).toFixed(6)), payer, refundTo: payer, depositAddress: exact ? null : `sim:0x${hex(40)}`,
    originTx: `sim:0x${hex(64)}`, destTx: refunded ? null : `sim:${hex(44)}`, refundedAmount: refunded ? amountIn.toString() : null, refundReason: refunded ? "PARTIAL_DEPOSIT" : null,
    operationId: exact ? null : `sim:${hex(16)}`, sessionId: null, upstreamCost: ep.resaleOf.length && !refunded ? "14000" : "0", shielded: false, simulated: true,
  };
  s.payments.push(p);
  s.probes.push({ id: `prb_web${n}`, ts: ts - 3000, endpointId: ep.id, buyer: `b_web_agent${n % 7}`, originChain: chain.key, stage: refunded ? "refunded" : "paid", inferredReason: refunded ? "Deposit below the quoted minimum: refunded to payer" : null, paymentId: id });
  if (n % 3 === 0) {
    s.probes.push({ id: `prb_web${n}b`, ts: ts - 1000, endpointId: ep.id, buyer: `b_web_visitor${n}`, originChain: null, stage: "probed", inferredReason: "Left after seeing the price: no quote requested", paymentId: null });
  }
}

function startAgent(s: Snapshot): void {
  if (agentStarted) return;
  agentStarted = true;
  setInterval(() => agentPayment(s), 6000);
}

function q(path: string): { route: string; params: URLSearchParams } {
  const u = new URL(path, "https://hosted.invalid");
  return { route: u.pathname, params: u.searchParams };
}

/** Same contract as the admin API (path relative to /api/admin, plus /api/public/stats). */
export async function staticApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const s = await load();
  startAgent(s);
  const now = Date.now();
  const { route, params } = q(path);
  const days = Math.min(Math.max(Number(params.get("days") ?? 30) || 30, 1), 90);
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET") throw new ApiError(403, "Disabled in the hosted demo. Run Penstock locally to protect endpoints (see README).");
  const result = ((): unknown => {
    switch (route) {
      case "/public/stats":
        return stats(s, now);
      case "/overview":
        return { mode: "demo", simulation: { quotes: true, settlement: true, label: HOSTED_LABEL }, seller: s.seller, account: accountCheck(s, s.seller.nearAccount), ...overview(s, now, days) };
      case "/payments":
        return listPayments(s, { status: params.get("status") || undefined, chain: params.get("chain") || undefined, endpoint: params.get("endpoint") || undefined, limit: Number(params.get("limit") ?? 50), offset: Number(params.get("offset") ?? 0) });
      case "/funnel":
        return funnel(s, now, days);
      case "/sessions":
        return sessionsView(s);
      case "/endpoints":
        return endpointsView(s, now, days);
      case "/shielded":
        return { ...s.shielded, shieldedPayments: s.payments.filter((p) => p.shielded).length };
      case "/account-check":
        return accountCheck(s, (params.get("account") ?? s.seller.nearAccount).slice(0, 64));
      case "/sellers":
        return { sellers: s.sellers };
      default: {
        const m = /^\/payments\/(pay_[A-Za-z0-9_]{1,40})$/.exec(route);
        if (m) {
          const p = s.payments.find((x) => x.id === m[1]);
          if (!p) throw new ApiError(404, "unknown payment");
          const receipt: Receipt | undefined = s.receipts[p.id];
          const session = p.sessionId ? s.sessions.find((x) => x.id === p.sessionId) ?? null : null;
          return {
            payment: p,
            receipt: receipt ?? { body: { v: 1, kind: "payment", paymentId: p.id, endpoint: p.endpointId, amountUsdc: p.amountOut, originChain: p.originChain, simulated: true, note: "generated in your browser by the hosted demo; not signed" }, sig: "", pub: "" },
            // Build-time receipts were verified when signed; browser-generated ones are not signed at all.
            receiptValid: receipt ? true : null,
            session,
            upstreamReceipts: [],
          };
        }
        throw new ApiError(404, "not found");
      }
    }
  })();
  return JSON.parse(JSON.stringify(result)) as T;
}

/** Builds the accountant CSV in the browser and downloads it. */
export async function downloadStaticCsv(days: number): Promise<void> {
  const s = await load();
  const now = Date.now();
  const csv = exportCsv(s, now - days * 86_400_000, now);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `penstock-hosted-demo-${new Date(now).toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
