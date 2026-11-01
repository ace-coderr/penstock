import type { EndpointRow, Funnel, Overview, Payment, Session, Stage } from "../types";
import type { Snapshot, SnapshotProbe } from "./snapshot";

/**
 * Pure re-implementations of the proxy's admin API responses (apps/proxy/src/admin-api.ts),
 * computed from snapshot rows. A parity test runs both on the same seed and compares them.
 */

const DAY = 86_400_000;
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

export const HOSTED_LABEL = "Hosted demo: everything here is simulated, computed in your browser. No network, no funds.";

export function formatUnits(v: bigint | string, decimals: number): string {
  const n = typeof v === "bigint" ? v : BigInt(v);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / base}${frac ? "." + frac : ""}`;
}

export function overview(s: Snapshot, now: number, days = 30): Omit<Overview, "mode" | "simulation" | "seller" | "account"> & { upstreamCostUsdc: string; refundedSessionsUsdc: string; simulatedShare: number } {
  const since = now - days * DAY;
  const payments = s.payments.filter((p) => p.ts >= since);
  const sessions = s.sessions.filter((x) => x.openedAt >= since);
  const probes = s.probes.filter((p) => p.ts >= since);
  const settled = payments.filter((p) => p.status === "settled");
  const received = sum(settled.map((p) => BigInt(p.amountOut)));
  const upstream = sum(settled.map((p) => BigInt(p.upstreamCost)));
  const sessionSpent = sum(sessions.map((x) => BigInt(x.spentUsdc)));
  const sessionRefunds = sum(sessions.map((x) => BigInt(x.refundUsdc ?? "0")));
  const float = sum(sessions.filter((x) => x.status === "open").map((x) => BigInt(x.fundedUsdc) - BigInt(x.spentUsdc)));
  const revenue = sum(payments.filter((p) => p.status === "settled" && !p.sessionId).map((p) => BigInt(p.amountOut))) + sessionSpent - upstream;
  const byChain = s.chains.map((c) => {
    const mine = payments.filter((p) => p.originChain === c.key);
    return { chain: c.key, label: c.label, tag: c.tag, color: c.color, receivedUsdc: sum(mine.filter((p) => p.status === "settled").map((p) => BigInt(p.amountOut))).toString(), count: mine.length, refunded: mine.filter((p) => p.status === "refunded").length };
  }).filter((x) => x.count > 0).sort((a, b) => Number(BigInt(b.receivedUsdc) - BigInt(a.receivedUsdc)));
  const dayStart = Math.floor(now / DAY) * DAY;
  const daily = Array.from({ length: days }, (_, i) => {
    const from = dayStart - (days - 1 - i) * DAY;
    const xs = settled.filter((p) => p.ts >= from && p.ts < from + DAY);
    return { day: new Date(from).toISOString().slice(0, 10), receivedUsdc: sum(xs.map((p) => BigInt(p.amountOut))).toString(), count: xs.length };
  });
  const paidProbes = probes.filter((p) => p.stage === "paid").length;
  return {
    days, receivedUsdc: received.toString(), revenueUsdc: revenue.toString(), upstreamCostUsdc: upstream.toString(), payments: payments.length, settled: settled.length,
    refunds: payments.filter((p) => p.status === "refunded").length, refundedSessionsUsdc: sessionRefunds.toString(), sessionFloatUsdc: float.toString(),
    openSessions: sessions.filter((x) => x.status === "open").length, buyerFeesUsd: Number(payments.reduce((a, p) => a + p.feeUsd, 0).toFixed(4)),
    conversion: probes.length ? Number((paidProbes / probes.length).toFixed(4)) : null, probes: probes.length, byChain, daily,
    simulatedShare: payments.length ? payments.filter((p) => p.simulated).length / payments.length : 0,
  };
}

const STAGES: SnapshotProbe["stage"][] = ["probed", "quoted", "deposited", "paid"];

export function funnel(s: Snapshot, now: number, days = 30): Funnel {
  const probes = s.probes.filter((p) => p.ts >= now - days * DAY).sort((a, b) => b.ts - a.ts);
  const rank: Record<SnapshotProbe["stage"], number> = { probed: 0, quoted: 1, deposited: 2, paid: 3, refunded: 2 };
  const reached = (xs: SnapshotProbe[]): Stage[] => STAGES.map((stage, i) => ({ stage, count: xs.filter((p) => rank[p.stage] >= i && !(stage === "paid" && p.stage === "refunded")).length }));
  const reasons = new Map<string, { reason: string; stage: string; count: number }>();
  for (const p of probes) {
    if (!p.inferredReason) continue;
    const k = `${p.stage}|${p.inferredReason}`;
    const r = reasons.get(k) ?? { reason: p.inferredReason, stage: p.stage, count: 0 };
    r.count++;
    reasons.set(k, r);
  }
  return {
    days,
    note: "Drop-off reasons are inferred from buyer behaviour (what they did next), not stated by buyers.",
    buyers: new Set(probes.map((p) => p.buyer)).size,
    stages: reached(probes),
    byEndpoint: s.endpoints.map((e) => ({ endpoint: e.id, stages: reached(probes.filter((p) => p.endpointId === e.id)) })),
    inferredReasons: [...reasons.values()].sort((a, b) => b.count - a.count),
    recent: probes.slice(0, 40).map((p) => ({ ts: p.ts, endpoint: p.endpointId, buyer: p.buyer, stage: p.stage, chain: p.originChain, inferredReason: p.inferredReason, paymentId: p.paymentId })),
  };
}

export function listPayments(s: Snapshot, q: { status?: string; chain?: string; endpoint?: string; limit?: number; offset?: number }): { total: number; payments: Payment[] } {
  const rows = s.payments
    .filter((p) => (!q.status || p.status === q.status) && (!q.chain || p.originChain === q.chain) && (!q.endpoint || p.endpointId === q.endpoint))
    .sort((a, b) => b.ts - a.ts);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  return { total: rows.length, payments: rows.slice(offset, offset + limit) };
}

export function endpointsView(s: Snapshot, now: number, days = 30): { endpoints: EndpointRow[] } {
  const payments = s.payments.filter((p) => p.ts >= now - days * DAY);
  return {
    endpoints: s.endpoints.map((e) => {
      const mine = payments.filter((p) => p.endpointId === e.id && p.status === "settled" && !p.sessionId);
      const gross = sum(mine.map((p) => BigInt(p.amountOut)));
      const up = sum(mine.map((p) => BigInt(p.upstreamCost)));
      return {
        ...e, upstreamHost: new URL(e.upstreamUrl).host, url: `${s.origin}/p/${e.sellerId}/${e.slug}`, calls: mine.length, grossUsdc: gross.toString(),
        upstreamCostUsdc: up.toString(), marginPerCallUsdc: mine.length ? ((gross - up) / BigInt(mine.length)).toString() : null,
      };
    }),
  };
}

export function sessionsView(s: Snapshot): { capUsdc: string; sessions: Session[] } {
  return { capUsdc: s.capUsdc, sessions: [...s.sessions].sort((a, b) => b.openedAt - a.openedAt).slice(0, 200) };
}

export function accountCheck(s: Snapshot, account: string) {
  const valid = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(account);
  if (!valid) return { account, exists: false, method: "format" as const, message: `"${account}" is not a valid NEAR account id.` };
  const known = s.sellers.some((x) => x.nearAccount === account);
  return {
    account, exists: known, method: "simulated" as const,
    message: known ? `${account} exists (simulated check: demo accounts only).` : `${account} was not found (simulated check). In live mode Penstock asks NEAR RPC; 1Click rejects quotes to accounts that do not exist.`,
  };
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ["date_utc", "entry_id", "type", "endpoint", "description", "gross_usdc", "refund_usdc", "upstream_cost_usdc", "net_usdc", "buyer_paid_amount", "buyer_paid_asset", "buyer_paid_chain", "buyer_route_fee_usd", "status", "settlement_tx_near", "origin_tx", "payer", "session_id", "simulated"];

export function exportCsv(s: Snapshot, from: number, to: number): string {
  const endpoints = new Map(s.endpoints.map((e) => [e.id, e]));
  const rows: unknown[][] = [];
  for (const p of s.payments.filter((x) => x.ts >= from && x.ts <= to)) {
    const chain = s.chains.find((c) => c.key === p.originChain);
    const decimals = chain?.assets.find((a) => a.symbol === p.originSymbol)?.decimals ?? 6;
    const gross = p.status === "settled" ? BigInt(p.amountOut) : 0n;
    const up = p.status === "settled" ? BigInt(p.upstreamCost) : 0n;
    const type = p.status === "refunded" || p.status === "failed" ? "payment_refunded_by_route" : p.sessionId ? "session_funding" : "sale";
    rows.push([new Date(p.ts).toISOString(), p.id, type, p.endpointId, endpoints.get(p.endpointId)?.description ?? "", formatUnits(gross, 6), "0", formatUnits(up, 6), formatUnits(gross - up, 6),
      formatUnits(p.amountIn, decimals), p.originSymbol, chain?.label ?? p.originChain, p.feeUsd.toFixed(6), p.status, p.destTx ?? "", p.originTx ?? "", p.payer, p.sessionId ?? "", p.simulated ? "yes" : "no"]);
  }
  for (const x of s.sessions.filter((y) => y.closedAt && y.closedAt >= from && y.closedAt <= to && y.refundUsdc && y.refundUsdc !== "0")) {
    const refund = BigInt(x.refundUsdc!);
    rows.push([new Date(x.closedAt!).toISOString(), `${x.id}-refund`, "session_refund", x.endpointId, `Unused session balance returned (${x.refundState ?? "none"})`, "0", formatUnits(refund, 6), "0", formatUnits(-refund, 6),
      "", "", "", "", x.refundState ?? "none", x.refundTx ?? "", "", x.refundTo, x.id, x.simulated ? "yes" : "no"]);
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return [CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function stats(s: Snapshot, now: number) {
  const o = overview(s, now, 30);
  return { simulated: true, days: o.days, seller: s.seller.name, payments: o.payments, chains: o.byChain.length, receivedUsdc: o.receivedUsdc, conversion: o.conversion, probes: o.probes };
}

/** Moves every timestamp forward so the snapshot reads as recent whenever the page is opened. */
export function rebase(s: Snapshot, now: number): Snapshot {
  const shift = now - s.generatedAt;
  const t = (x: number) => x + shift;
  const tn = (x: number | null | undefined) => (x == null ? (x as null) : x + shift);
  return {
    ...s,
    generatedAt: now,
    payments: s.payments.map((p) => ({ ...p, ts: t(p.ts) })),
    probes: s.probes.map((p) => ({ ...p, ts: t(p.ts) })),
    sessions: s.sessions.map((x) => ({ ...x, openedAt: t(x.openedAt), closedAt: tn(x.closedAt), expiresAt: tn(x.expiresAt) })),
  };
}
