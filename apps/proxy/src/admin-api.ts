import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CHAINS, HOME_SELLER_ID, formatUnits, parseUnits, simulationScope, verifyReceipt,
  type Endpoint, type Payment, type Probe, type SignedReceipt,
} from "@penstock/core";
import type { AccountChecker } from "./account-check";
import type { ShieldedRoutes } from "@penstock/shielded";
import { clientAddress, HttpError, readJson, sendJson, sendRaw } from "./http";
import type { ProxyContext } from "./paywall";
import { validateUpstreamUrl } from "./upstream";

/**
 * Seller console API under /api/admin. Protected by ADMIN_TOKEN (Bearer). Without a token, which
 * is only allowed in demo and dry mode, it answers loopback clients only.
 */

const DAY = 86_400_000;
const isLoopback = (a: string) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";

function authorize(ctx: ProxyContext, req: IncomingMessage): void {
  const token = ctx.config.adminToken;
  if (!token) {
    // Token-less access is a local demo convenience: loopback socket, no forwarding proxy in front,
    // and a localhost Host header (defeats DNS rebinding from a web page).
    const forwarded = req.headers["x-forwarded-for"] !== undefined || req.headers.forwarded !== undefined || ctx.trustProxy;
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const localHost = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (ctx.config.mode === "live" || forwarded || !localHost || !isLoopback(clientAddress(req, false))) throw new HttpError(401, "admin API requires ADMIN_TOKEN", "unauthorized");
    return;
  }
  const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, "invalid admin token", "unauthorized");
}

/** Stored receipt for a payment; seeded history gets one signed on first view (flagged simulated). */
export function receiptFor(ctx: ProxyContext, p: Payment): SignedReceipt {
  const raw = ctx.store.getKv(`receipt:${p.id}`);
  if (raw) return JSON.parse(raw) as SignedReceipt;
  const seller = ctx.store.getSeller(p.sellerId);
  const r = ctx.receipts.sign({
    v: 1, kind: p.sessionId ? "session-funding" : "payment", paymentId: p.id, ...(p.sessionId ? { sessionId: p.sessionId } : {}), seller: seller?.nearAccount ?? p.sellerId, endpoint: p.endpointId,
    amountUsdc: p.amountOut, network: "near:mainnet", transaction: p.destTx ?? "", originChain: p.originChain, originTx: p.originTx, payer: p.payer, ts: p.ts,
    status: p.status, simulated: p.simulated, note: "issued from seeded demo history",
  });
  ctx.store.setKv(`receipt:${p.id}`, JSON.stringify(r));
  return r;
}

function isRevenue(p: Payment): boolean {
  return p.status === "settled" && !p.sessionId;
}

export function overview(ctx: ProxyContext, sellerId: string, days = 30) {
  const since = ctx.now() - days * DAY;
  const payments = ctx.store.listPayments({ sellerId, since, limit: 5000 });
  const sessions = ctx.store.listSessions(sellerId, 2000).filter((s) => s.openedAt >= since);
  const endpoints = ctx.store.listEndpoints(sellerId);
  const probes = ctx.store.listProbes({ endpointIds: endpoints.map((e) => e.id), since });
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const settled = payments.filter((p) => p.status === "settled");
  const received = sum(settled.map((p) => BigInt(p.amountOut)));
  const upstream = sum(settled.map((p) => BigInt(p.upstreamCost)));
  const sessionSpent = sum(sessions.map((s) => BigInt(s.spentUsdc)));
  const sessionRefunds = sum(sessions.map((s) => BigInt(s.refundUsdc ?? "0")));
  const float = sum(sessions.filter((s) => s.status === "open").map((s) => BigInt(s.fundedUsdc) - BigInt(s.spentUsdc)));
  const revenue = sum(payments.filter(isRevenue).map((p) => BigInt(p.amountOut))) + sessionSpent - upstream;
  const refunded = payments.filter((p) => p.status === "refunded");
  const byChain = CHAINS.map((c) => {
    const mine = payments.filter((p) => p.originChain === c.key);
    return { chain: c.key, label: c.label, tag: c.tag, color: c.color, receivedUsdc: sum(mine.filter((p) => p.status === "settled").map((p) => BigInt(p.amountOut))).toString(), count: mine.length, refunded: mine.filter((p) => p.status === "refunded").length };
  }).filter((x) => x.count > 0).sort((a, b) => Number(BigInt(b.receivedUsdc) - BigInt(a.receivedUsdc)));
  const dayStart = Math.floor(ctx.now() / DAY) * DAY;
  const daily = Array.from({ length: days }, (_, i) => {
    const from = dayStart - (days - 1 - i) * DAY;
    const xs = settled.filter((p) => p.ts >= from && p.ts < from + DAY);
    return { day: new Date(from).toISOString().slice(0, 10), receivedUsdc: sum(xs.map((p) => BigInt(p.amountOut))).toString(), count: xs.length };
  });
  const paidProbes = probes.filter((p) => p.stage === "paid").length;
  return {
    days,
    receivedUsdc: received.toString(),
    revenueUsdc: revenue.toString(),
    upstreamCostUsdc: upstream.toString(),
    payments: payments.length,
    settled: settled.length,
    refunds: refunded.length,
    refundedSessionsUsdc: sessionRefunds.toString(),
    sessionFloatUsdc: float.toString(),
    openSessions: sessions.filter((s) => s.status === "open").length,
    buyerFeesUsd: Number(payments.reduce((a, p) => a + p.feeUsd, 0).toFixed(4)),
    conversion: probes.length ? Number((paidProbes / probes.length).toFixed(4)) : null,
    probes: probes.length,
    byChain,
    daily,
    simulatedShare: payments.length ? payments.filter((p) => p.simulated).length / payments.length : 0,
  };
}

const STAGES: Probe["stage"][] = ["probed", "quoted", "deposited", "paid"];

export function funnel(ctx: ProxyContext, sellerId: string, days = 30) {
  const endpoints = ctx.store.listEndpoints(sellerId);
  const probes = ctx.store.listProbes({ endpointIds: endpoints.map((e) => e.id), since: ctx.now() - days * DAY });
  const rank: Record<Probe["stage"], number> = { probed: 0, quoted: 1, deposited: 2, paid: 3, refunded: 2 };
  const reached = (xs: Probe[]) => STAGES.map((stage, i) => ({ stage, count: xs.filter((p) => rank[p.stage] >= i && !(stage === "paid" && p.stage === "refunded")).length }));
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
    byEndpoint: endpoints.map((e) => ({ endpoint: e.id, stages: reached(probes.filter((p) => p.endpointId === e.id)) })),
    inferredReasons: [...reasons.values()].sort((a, b) => b.count - a.count),
    recent: probes.slice(0, 40).map((p) => ({ ts: p.ts, endpoint: p.endpointId, buyer: p.buyer, stage: p.stage, chain: p.originChain, inferredReason: p.inferredReason, paymentId: p.paymentId })),
  };
}

/** One quoted cell; neutralises spreadsheet formula injection. */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(ctx: ProxyContext, sellerId: string, from: number, to: number): string {
  const endpoints = new Map(ctx.store.listEndpoints(sellerId).map((e) => [e.id, e]));
  const header = ["date_utc", "entry_id", "type", "endpoint", "description", "gross_usdc", "refund_usdc", "upstream_cost_usdc", "net_usdc", "buyer_paid_amount", "buyer_paid_asset", "buyer_paid_chain", "buyer_route_fee_usd", "status", "settlement_tx_near", "origin_tx", "payer", "session_id", "simulated"];
  const rows: unknown[][] = [];
  for (const p of ctx.store.listPayments({ sellerId, since: from, limit: 5000 }).filter((x) => x.ts <= to).reverse()) {
    const e = endpoints.get(p.endpointId);
    const chain = CHAINS.find((c) => c.key === p.originChain);
    const decimals = chain?.assets.find((a) => a.symbol === p.originSymbol)?.decimals ?? 6;
    const gross = p.status === "settled" ? BigInt(p.amountOut) : 0n;
    const up = p.status === "settled" ? BigInt(p.upstreamCost) : 0n;
    const type = p.status === "refunded" || p.status === "failed" ? "payment_refunded_by_route" : p.sessionId ? "session_funding" : "sale";
    rows.push([new Date(p.ts).toISOString(), p.id, type, p.endpointId, e?.description ?? "", formatUnits(gross, 6), "0", formatUnits(up, 6), formatUnits(gross - up, 6),
      formatUnits(p.amountIn, decimals), p.originSymbol, chain?.label ?? p.originChain, p.feeUsd.toFixed(6), p.status, p.destTx ?? "", p.originTx ?? "", p.payer, p.sessionId ?? "", p.simulated ? "yes" : "no"]);
  }
  for (const s of ctx.store.listSessions(sellerId, 5000).filter((x) => x.closedAt && x.closedAt >= from && x.closedAt <= to && x.refundUsdc && x.refundUsdc !== "0")) {
    const refund = BigInt(s.refundUsdc!);
    rows.push([new Date(s.closedAt!).toISOString(), `${s.id}-refund`, "session_refund", s.endpointId, `Unused session balance returned (${s.refundState ?? "none"})`, "0", formatUnits(refund, 6), "0", formatUnits(-refund, 6),
      "", "", "", "", s.refundState ?? "none", s.refundTx ?? "", "", s.refundTo, s.id, s.simulated ? "yes" : "no"]);
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

export async function handleAdminApi(ctx: ProxyContext, accounts: AccountChecker, req: IncomingMessage, res: ServerResponse, url: URL, shielded?: ShieldedRoutes): Promise<void> {
  authorize(ctx, req);
  if (ctx.limiter.take("admin", clientAddress(req, ctx.trustProxy), ctx.now())) throw new HttpError(429, "rate limited", "rate_limited");
  const path = url.pathname.replace(/^\/api\/admin/, "");
  const sellerId = url.searchParams.get("seller") ?? HOME_SELLER_ID;
  const seller = ctx.store.getSeller(sellerId);
  if (!seller && path !== "/sellers") throw new HttpError(404, "unknown seller", "not_found");
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30) || 30, 1), 90);
  const method = req.method ?? "GET";
  // Writes must be JSON: a cross-site form or text/plain POST cannot set this without a CORS preflight.
  if (method !== "GET" && method !== "HEAD" && !/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
    throw new HttpError(415, "admin writes must be application/json", "unsupported_media_type");
  }

  if (method === "GET" && path === "/sellers") return sendJson(res, 200, { sellers: ctx.store.listSellers() });
  if (method === "GET" && path === "/overview") {
    const account = accounts.cached(seller!.nearAccount) ?? (await accounts.check(seller!.nearAccount));
    return sendJson(res, 200, { mode: ctx.config.mode, simulation: simulationScope(ctx.config.mode), seller, account, ...overview(ctx, sellerId, days) });
  }
  if (method === "GET" && path === "/account-check") {
    const account = url.searchParams.get("account") ?? seller!.nearAccount;
    return sendJson(res, 200, await accounts.check(account.slice(0, 64)));
  }
  if (method === "GET" && path === "/payments") {
    const q = { sellerId, status: url.searchParams.get("status") || undefined, chain: url.searchParams.get("chain") || undefined, endpointId: url.searchParams.get("endpoint") || undefined };
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 500);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    return sendJson(res, 200, { total: ctx.store.countPayments(q), payments: ctx.store.listPayments({ ...q, limit, offset }) });
  }
  const pm = /^\/payments\/(pay_[A-Za-z0-9_]{1,40})$/.exec(path);
  if (method === "GET" && pm) {
    const p = ctx.store.getPayment(pm[1]!);
    if (!p || p.sellerId !== sellerId) throw new HttpError(404, "unknown payment", "not_found");
    const receipt = receiptFor(ctx, p);
    const session = p.sessionId ? ctx.store.getSession(p.sessionId) : undefined;
    const { secretHash: _omit, ...publicSession } = session ?? ({ secretHash: "" } as { secretHash: string });
    const resale = JSON.parse(ctx.store.getKv(`resale:${p.id}`) ?? "[]") as SignedReceipt[];
    return sendJson(res, 200, { payment: p, receipt, receiptValid: verifyReceipt(receipt), session: session ? publicSession : null, upstreamReceipts: resale.map((r) => ({ ...r, valid: verifyReceipt(r) })) });
  }
  if (method === "GET" && path === "/shielded") {
    const sh = shielded ? await shielded.status() : { active: null, routes: [], scope: null };
    const shieldedPayments = ctx.store.listPayments({ sellerId, limit: 5000 }).filter((p) => p.shielded).length;
    return sendJson(res, 200, { ...sh, shieldedPayments });
  }
  if (method === "GET" && path === "/funnel") return sendJson(res, 200, funnel(ctx, sellerId, days));
  if (method === "GET" && path === "/sessions") return sendJson(res, 200, { capUsdc: parseUnits(ctx.config.sessionCapUsd, 6).toString(), sessions: ctx.store.listSessions(sellerId, 200) });
  if (method === "GET" && path === "/endpoints") {
    const since = ctx.now() - days * DAY;
    const payments = ctx.store.listPayments({ sellerId, since, limit: 5000 });
    return sendJson(res, 200, {
      endpoints: ctx.store.listEndpoints(sellerId).map((e) => {
        const mine = payments.filter((p) => p.endpointId === e.id && p.status === "settled" && !p.sessionId);
        const gross = mine.reduce((a, p) => a + BigInt(p.amountOut), 0n);
        const up = mine.reduce((a, p) => a + BigInt(p.upstreamCost), 0n);
        return { ...e, upstreamHost: new URL(e.upstreamUrl).host, url: `${ctx.config.publicUrl}/p/${sellerId}/${e.slug}`, calls: mine.length, grossUsdc: gross.toString(), upstreamCostUsdc: up.toString(), marginPerCallUsdc: mine.length ? ((gross - up) / BigInt(mine.length)).toString() : null };
      }),
    });
  }
  if (method === "POST" && path === "/endpoints") {
    const b = await readJson<{ slug?: string; upstreamUrl?: string; priceUsd?: string; description?: string; methods?: string[]; capabilities?: string[]; sessionsEnabled?: boolean }>(req, 8192);
    if (!b.slug || !SLUG.test(b.slug)) throw new HttpError(400, "slug: lowercase letters, digits and dashes", "invalid_slug");
    if (ctx.store.findEndpoint(sellerId, b.slug)) throw new HttpError(409, "an endpoint with this slug exists", "exists");
    const v = validateUpstreamUrl(String(b.upstreamUrl ?? ""), ctx.allowPrivateUpstreams, [ctx.config.port]);
    if (!v.ok) throw new HttpError(400, `upstreamUrl: ${v.reason}`, "invalid_upstream");
    let price: bigint;
    try {
      price = parseUnits(String(b.priceUsd ?? ""), 6);
    } catch {
      throw new HttpError(400, "priceUsd: a decimal like 0.005", "invalid_price");
    }
    if (price < 1n || price > 100_000_000n) throw new HttpError(400, "priceUsd must be between 0.000001 and 100", "invalid_price");
    const methods = (b.methods ?? ["GET"]).map((m) => String(m).toUpperCase()).filter((m) => m === "GET" || m === "POST");
    const e: Endpoint = {
      id: `${sellerId}.${b.slug}`, sellerId, slug: b.slug, kind: "http", description: String(b.description ?? "").slice(0, 200) || b.slug,
      capabilities: (b.capabilities ?? []).map((c) => String(c).toLowerCase().replace(/[^a-z0-9-]/g, "")).filter(Boolean).slice(0, 8),
      priceUsdc: price.toString(), upstreamUrl: v.url.href, methods: methods.length ? methods : ["GET"], sessionsEnabled: !!b.sessionsEnabled, resaleOf: [],
    };
    ctx.store.upsertEndpoint(e);
    return sendJson(res, 201, { endpoint: e, url: `${ctx.config.publicUrl}/p/${sellerId}/${e.slug}` });
  }
  if (method === "GET" && path === "/export.csv") {
    const from = Date.parse(url.searchParams.get("from") ?? "") || ctx.now() - days * DAY;
    const to = Date.parse(url.searchParams.get("to") ?? "") || ctx.now();
    const csv = exportCsv(ctx, sellerId, from, to);
    return sendRaw(res, 200, csv, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="penstock-${sellerId}-${new Date(from).toISOString().slice(0, 10)}-to-${new Date(to).toISOString().slice(0, 10)}.csv"` });
  }
  throw new HttpError(404, "not found", "not_found");
}
