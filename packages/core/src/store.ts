import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Endpoint, FunnelStage, Payment, Probe, Seller, Session } from "./types";

/**
 * The ledger. SQLite (node:sqlite) so claims and idempotency keys are enforced by the database
 * with UNIQUE constraints and conditional UPDATEs, not by in-process maps.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, near_account TEXT NOT NULL, description TEXT NOT NULL,
  origin TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES sellers(id), slug TEXT NOT NULL, kind TEXT NOT NULL,
  description TEXT NOT NULL, capabilities TEXT NOT NULL, price_usdc TEXT NOT NULL, upstream_url TEXT NOT NULL,
  methods TEXT NOT NULL, sessions_enabled INTEGER NOT NULL, resale_of TEXT NOT NULL,
  UNIQUE (seller_id, slug)
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, seller_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, method TEXT NOT NULL,
  status TEXT NOT NULL, origin_chain TEXT NOT NULL, origin_asset TEXT NOT NULL, origin_symbol TEXT NOT NULL,
  amount_in TEXT NOT NULL, amount_in_usd REAL NOT NULL, amount_out TEXT NOT NULL, fee_usd REAL NOT NULL,
  payer TEXT NOT NULL, refund_to TEXT NOT NULL, deposit_address TEXT UNIQUE, origin_tx TEXT, dest_tx TEXT,
  refunded_amount TEXT, refund_reason TEXT, operation_id TEXT UNIQUE, session_id TEXT,
  upstream_cost TEXT NOT NULL DEFAULT '0', shielded INTEGER NOT NULL DEFAULT 0, simulated INTEGER NOT NULL,
  receipt_sig TEXT
);
CREATE INDEX IF NOT EXISTS payments_seller_ts ON payments (seller_id, ts DESC);
CREATE TABLE IF NOT EXISTS probes (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, endpoint_id TEXT NOT NULL, buyer TEXT NOT NULL, origin_chain TEXT,
  stage TEXT NOT NULL, inferred_reason TEXT, payment_id TEXT, simulated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS probes_endpoint_ts ON probes (endpoint_id, ts DESC);
CREATE INDEX IF NOT EXISTS probes_buyer ON probes (buyer, endpoint_id, ts DESC);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, buyer TEXT NOT NULL,
  cap_usdc TEXT NOT NULL, funded_usdc TEXT NOT NULL, spent_usdc TEXT NOT NULL, settled_usdc TEXT NOT NULL,
  status TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER, refund_usdc TEXT,
  funding_payment_id TEXT NOT NULL UNIQUE, refund_to TEXT NOT NULL, origin_chain TEXT NOT NULL, simulated INTEGER NOT NULL,
  secret_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, cost_usdc TEXT NOT NULL,
  batch_id TEXT
);
CREATE TABLE IF NOT EXISTS operations (
  instrument TEXT PRIMARY KEY, claim_until INTEGER, claim_owner TEXT, result TEXT, executed_at INTEGER,
  quoted_entry TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_payloads (
  hash TEXT PRIMARY KEY, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

type Row = Record<string, SQLInputValue>;

function toSeller(r: Row): Seller {
  return { id: String(r.id), name: String(r.name), nearAccount: String(r.near_account), description: String(r.description), origin: String(r.origin), simulated: !!r.simulated };
}

function toEndpoint(r: Row): Endpoint {
  return {
    id: String(r.id), sellerId: String(r.seller_id), slug: String(r.slug), kind: r.kind === "mcp" ? "mcp" : "http",
    description: String(r.description), capabilities: JSON.parse(String(r.capabilities)), priceUsdc: String(r.price_usdc),
    upstreamUrl: String(r.upstream_url), methods: JSON.parse(String(r.methods)), sessionsEnabled: !!r.sessions_enabled,
    resaleOf: JSON.parse(String(r.resale_of)),
  };
}

const s = (v: SQLInputValue | undefined): string | null => (v === null || v === undefined ? null : String(v));

function toPayment(r: Row): Payment {
  return {
    id: String(r.id), ts: Number(r.ts), sellerId: String(r.seller_id), endpointId: String(r.endpoint_id),
    method: r.method as Payment["method"], status: r.status as Payment["status"], originChain: String(r.origin_chain),
    originAsset: String(r.origin_asset), originSymbol: String(r.origin_symbol), amountIn: String(r.amount_in),
    amountInUsd: Number(r.amount_in_usd), amountOut: String(r.amount_out), feeUsd: Number(r.fee_usd), payer: String(r.payer),
    refundTo: String(r.refund_to), depositAddress: s(r.deposit_address), originTx: s(r.origin_tx), destTx: s(r.dest_tx),
    refundedAmount: s(r.refunded_amount), refundReason: s(r.refund_reason), operationId: s(r.operation_id),
    sessionId: s(r.session_id), upstreamCost: String(r.upstream_cost ?? "0"), shielded: !!r.shielded, simulated: !!r.simulated,
    receiptSig: s(r.receipt_sig),
  };
}

function toProbe(r: Row): Probe {
  return {
    id: String(r.id), ts: Number(r.ts), endpointId: String(r.endpoint_id), buyer: String(r.buyer), originChain: s(r.origin_chain),
    stage: r.stage as FunnelStage, inferredReason: s(r.inferred_reason), paymentId: s(r.payment_id), simulated: !!r.simulated,
  };
}

function toSession(r: Row): Session {
  return {
    id: String(r.id), sellerId: String(r.seller_id), endpointId: String(r.endpoint_id), buyer: String(r.buyer),
    capUsdc: String(r.cap_usdc), fundedUsdc: String(r.funded_usdc), spentUsdc: String(r.spent_usdc), settledUsdc: String(r.settled_usdc),
    status: r.status as Session["status"], openedAt: Number(r.opened_at), closedAt: r.closed_at == null ? null : Number(r.closed_at),
    refundUsdc: s(r.refund_usdc), fundingPaymentId: String(r.funding_payment_id), refundTo: String(r.refund_to),
    originChain: String(r.origin_chain), simulated: !!r.simulated,
  };
}

export interface PaymentQuery {
  sellerId?: string;
  endpointId?: string;
  status?: string;
  chain?: string;
  since?: number;
  limit?: number;
  offset?: number;
}

export type ClaimResult =
  | { state: "claimed" }
  | { state: "busy" }
  | { state: "recorded"; result: unknown };

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ── sellers / endpoints ────────────────────────────────────────────────

  upsertSeller(x: Seller): void {
    this.db.prepare(`INSERT INTO sellers (id,name,near_account,description,origin,simulated) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, near_account=excluded.near_account, description=excluded.description, origin=excluded.origin, simulated=excluded.simulated`)
      .run(x.id, x.name, x.nearAccount, x.description, x.origin, x.simulated ? 1 : 0);
  }

  listSellers(): Seller[] {
    return (this.db.prepare("SELECT * FROM sellers ORDER BY name").all() as Row[]).map(toSeller);
  }

  getSeller(id: string): Seller | undefined {
    const r = this.db.prepare("SELECT * FROM sellers WHERE id = ?").get(id) as Row | undefined;
    return r ? toSeller(r) : undefined;
  }

  upsertEndpoint(e: Endpoint): void {
    this.db.prepare(`INSERT INTO endpoints (id,seller_id,slug,kind,description,capabilities,price_usdc,upstream_url,methods,sessions_enabled,resale_of)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, kind=excluded.kind, description=excluded.description,
      capabilities=excluded.capabilities, price_usdc=excluded.price_usdc, upstream_url=excluded.upstream_url, methods=excluded.methods,
      sessions_enabled=excluded.sessions_enabled, resale_of=excluded.resale_of`)
      .run(e.id, e.sellerId, e.slug, e.kind, e.description, JSON.stringify(e.capabilities), e.priceUsdc, e.upstreamUrl,
        JSON.stringify(e.methods), e.sessionsEnabled ? 1 : 0, JSON.stringify(e.resaleOf));
  }

  listEndpoints(sellerId?: string): Endpoint[] {
    const rows = sellerId
      ? this.db.prepare("SELECT * FROM endpoints WHERE seller_id = ? ORDER BY slug").all(sellerId)
      : this.db.prepare("SELECT * FROM endpoints ORDER BY seller_id, slug").all();
    return (rows as Row[]).map(toEndpoint);
  }

  getEndpoint(id: string): Endpoint | undefined {
    const r = this.db.prepare("SELECT * FROM endpoints WHERE id = ?").get(id) as Row | undefined;
    return r ? toEndpoint(r) : undefined;
  }

  findEndpoint(sellerId: string, slug: string): Endpoint | undefined {
    const r = this.db.prepare("SELECT * FROM endpoints WHERE seller_id = ? AND slug = ?").get(sellerId, slug) as Row | undefined;
    return r ? toEndpoint(r) : undefined;
  }

  // ── payments ───────────────────────────────────────────────────────────

  insertPayment(p: Payment): void {
    this.db.prepare(`INSERT INTO payments (id,ts,seller_id,endpoint_id,method,status,origin_chain,origin_asset,origin_symbol,amount_in,amount_in_usd,
      amount_out,fee_usd,payer,refund_to,deposit_address,origin_tx,dest_tx,refunded_amount,refund_reason,operation_id,session_id,upstream_cost,shielded,simulated,receipt_sig)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, p.ts, p.sellerId, p.endpointId, p.method, p.status, p.originChain, p.originAsset, p.originSymbol, p.amountIn, p.amountInUsd,
        p.amountOut, p.feeUsd, p.payer, p.refundTo, p.depositAddress, p.originTx, p.destTx, p.refundedAmount, p.refundReason, p.operationId,
        p.sessionId, p.upstreamCost, p.shielded ? 1 : 0, p.simulated ? 1 : 0, p.receiptSig);
  }

  updatePayment(id: string, patch: Partial<Pick<Payment, "status" | "destTx" | "originTx" | "refundedAmount" | "refundReason" | "receiptSig" | "upstreamCost" | "payer">>): void {
    const cols: Record<string, string> = { status: "status", destTx: "dest_tx", originTx: "origin_tx", refundedAmount: "refunded_amount", refundReason: "refund_reason", receiptSig: "receipt_sig", upstreamCost: "upstream_cost", payer: "payer" };
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      vals.push(v as SQLInputValue);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE payments SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  getPayment(id: string): Payment | undefined {
    const r = this.db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as Row | undefined;
    return r ? toPayment(r) : undefined;
  }

  paymentByOperation(operationId: string): Payment | undefined {
    const r = this.db.prepare("SELECT * FROM payments WHERE operation_id = ?").get(operationId) as Row | undefined;
    return r ? toPayment(r) : undefined;
  }

  private where(q: PaymentQuery): { sql: string; vals: SQLInputValue[] } {
    const parts: string[] = [];
    const vals: SQLInputValue[] = [];
    if (q.sellerId) { parts.push("seller_id = ?"); vals.push(q.sellerId); }
    if (q.endpointId) { parts.push("endpoint_id = ?"); vals.push(q.endpointId); }
    if (q.status) { parts.push("status = ?"); vals.push(q.status); }
    if (q.chain) { parts.push("origin_chain = ?"); vals.push(q.chain); }
    if (q.since) { parts.push("ts >= ?"); vals.push(q.since); }
    return { sql: parts.length ? "WHERE " + parts.join(" AND ") : "", vals };
  }

  listPayments(q: PaymentQuery = {}): Payment[] {
    const { sql, vals } = this.where(q);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 5000);
    const offset = Math.max(q.offset ?? 0, 0);
    return (this.db.prepare(`SELECT * FROM payments ${sql} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset) as Row[]).map(toPayment);
  }

  countPayments(q: PaymentQuery = {}): number {
    const { sql, vals } = this.where(q);
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM payments ${sql}`).get(...vals) as Row).n);
  }

  // ── probes / funnel ────────────────────────────────────────────────────

  insertProbe(p: Probe): void {
    this.db.prepare("INSERT INTO probes (id,ts,endpoint_id,buyer,origin_chain,stage,inferred_reason,payment_id,simulated) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(p.id, p.ts, p.endpointId, p.buyer, p.originChain, p.stage, p.inferredReason, p.paymentId, p.simulated ? 1 : 0);
  }

  latestProbe(endpointId: string, buyer: string): Probe | undefined {
    const r = this.db.prepare("SELECT * FROM probes WHERE endpoint_id = ? AND buyer = ? ORDER BY ts DESC LIMIT 1").get(endpointId, buyer) as Row | undefined;
    return r ? toProbe(r) : undefined;
  }

  /** Sets the inferred drop-off reason on a probe that stalled. */
  setProbeReason(id: string, reason: string): void {
    this.db.prepare("UPDATE probes SET inferred_reason = ? WHERE id = ?").run(reason, id);
  }

  /** Advances the buyer's latest open probe on an endpoint; stages only move forward. */
  advanceProbe(endpointId: string, buyer: string, stage: FunnelStage, fields: { originChain?: string; paymentId?: string } = {}): void {
    const rank: Record<FunnelStage, number> = { probed: 0, quoted: 1, deposited: 2, paid: 3, refunded: 3 };
    const r = this.db.prepare("SELECT * FROM probes WHERE endpoint_id = ? AND buyer = ? ORDER BY ts DESC LIMIT 1").get(endpointId, buyer) as Row | undefined;
    if (!r) return;
    const cur = toProbe(r);
    if (rank[stage] < rank[cur.stage] || cur.stage === "paid" || cur.stage === "refunded") return;
    this.db.prepare("UPDATE probes SET stage = ?, origin_chain = COALESCE(?, origin_chain), payment_id = COALESCE(?, payment_id) WHERE id = ?")
      .run(stage, fields.originChain ?? null, fields.paymentId ?? null, cur.id);
  }

  listProbes(q: { endpointIds?: string[]; since?: number; limit?: number } = {}): Probe[] {
    const parts: string[] = [];
    const vals: SQLInputValue[] = [];
    if (q.endpointIds?.length) { parts.push(`endpoint_id IN (${q.endpointIds.map(() => "?").join(",")})`); vals.push(...q.endpointIds); }
    if (q.since) { parts.push("ts >= ?"); vals.push(q.since); }
    const where = parts.length ? "WHERE " + parts.join(" AND ") : "";
    const limit = Math.min(Math.max(q.limit ?? 5000, 1), 20000);
    return (this.db.prepare(`SELECT * FROM probes ${where} ORDER BY ts DESC LIMIT ?`).all(...vals, limit) as Row[]).map(toProbe);
  }

  // ── sessions ───────────────────────────────────────────────────────────

  insertSession(x: Session, secretHash: string): void {
    this.db.prepare(`INSERT INTO sessions (id,seller_id,endpoint_id,buyer,cap_usdc,funded_usdc,spent_usdc,settled_usdc,status,opened_at,closed_at,refund_usdc,funding_payment_id,refund_to,origin_chain,simulated,secret_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(x.id, x.sellerId, x.endpointId, x.buyer, x.capUsdc, x.fundedUsdc, x.spentUsdc, x.settledUsdc, x.status, x.openedAt, x.closedAt, x.refundUsdc,
        x.fundingPaymentId, x.refundTo, x.originChain, x.simulated ? 1 : 0, secretHash);
  }

  getSession(id: string): (Session & { secretHash: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? { ...toSession(r), secretHash: String(r.secret_hash) } : undefined;
  }

  listSessions(sellerId?: string, limit = 200): Session[] {
    const rows = sellerId
      ? this.db.prepare("SELECT * FROM sessions WHERE seller_id = ? ORDER BY opened_at DESC LIMIT ?").all(sellerId, limit)
      : this.db.prepare("SELECT * FROM sessions ORDER BY opened_at DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(toSession);
  }

  /**
   * Meters one call against an open session. Succeeds only if the session is open and the new
   * spend stays within the funded balance; the check and the write are one statement.
   */
  meterSessionCall(sessionId: string, cost: bigint, now: number): boolean {
    return this.tx(() => {
      const res = this.db.prepare(`UPDATE sessions SET spent_usdc = CAST(CAST(spent_usdc AS INTEGER) + ? AS TEXT)
        WHERE id = ? AND status = 'open' AND CAST(spent_usdc AS INTEGER) + ? <= CAST(funded_usdc AS INTEGER)`)
        .run(cost, sessionId, cost);
      if (Number(res.changes) !== 1) return false;
      this.db.prepare("INSERT INTO session_calls (session_id, ts, cost_usdc) VALUES (?,?,?)").run(sessionId, now, cost.toString());
      return true;
    });
  }

  /** Marks unbatched calls as settled in one batch and returns the batch total. */
  settleSessionBatch(sessionId: string, batchId: string): bigint {
    return this.tx(() => {
      const row = this.db.prepare("SELECT COALESCE(SUM(CAST(cost_usdc AS INTEGER)),0) AS t, COUNT(*) AS n FROM session_calls WHERE session_id = ? AND batch_id IS NULL").get(sessionId) as Row;
      const total = BigInt(Number(row.t));
      if (Number(row.n) === 0) return 0n;
      this.db.prepare("UPDATE session_calls SET batch_id = ? WHERE session_id = ? AND batch_id IS NULL").run(batchId, sessionId);
      this.db.prepare("UPDATE sessions SET settled_usdc = CAST(CAST(settled_usdc AS INTEGER) + ? AS TEXT) WHERE id = ?").run(total, sessionId);
      return total;
    });
  }

  /** Closes an open session exactly once; returns the refund, or null if it was already closed. */
  closeSession(sessionId: string, now: number): bigint | null {
    return this.tx(() => {
      const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Row | undefined;
      if (!r || r.status !== "open") return null;
      const refund = BigInt(String(r.funded_usdc)) - BigInt(String(r.spent_usdc));
      const res = this.db.prepare("UPDATE sessions SET status = 'closed', closed_at = ?, refund_usdc = ? WHERE id = ? AND status = 'open'")
        .run(now, refund.toString(), sessionId);
      return Number(res.changes) === 1 ? refund : null;
    });
  }

  sessionCalls(sessionId: string): { ts: number; costUsdc: string; batchId: string | null }[] {
    return (this.db.prepare("SELECT ts, cost_usdc, batch_id FROM session_calls WHERE session_id = ? ORDER BY id").all(sessionId) as Row[])
      .map((r) => ({ ts: Number(r.ts), costUsdc: String(r.cost_usdc), batchId: s(r.batch_id) }));
  }

  // ── operations: exactly-once claims and execution ──────────────────────

  /** Records a quoted operation so it can be settled later against the terms it was quoted with. */
  recordQuotedOperation(instrument: string, quotedEntry: unknown, now: number): void {
    this.db.prepare("INSERT INTO operations (instrument, quoted_entry, created_at) VALUES (?,?,?) ON CONFLICT(instrument) DO NOTHING")
      .run(instrument, JSON.stringify(quotedEntry), now);
  }

  getQuotedOperation(instrument: string): { quotedEntry: unknown; result: unknown; executedAt: number | null } | undefined {
    const r = this.db.prepare("SELECT * FROM operations WHERE instrument = ?").get(instrument) as Row | undefined;
    if (!r) return undefined;
    return { quotedEntry: r.quoted_entry ? JSON.parse(String(r.quoted_entry)) : null, result: r.result ? JSON.parse(String(r.result)) : null, executedAt: r.executed_at == null ? null : Number(r.executed_at) };
  }

  /** Claims an operation for settlement. Exactly one concurrent caller gets "claimed". */
  claimOperation(instrument: string, owner: string, ttlMs: number, now: number): ClaimResult {
    return this.tx(() => {
      this.db.prepare("INSERT INTO operations (instrument, created_at) VALUES (?, ?) ON CONFLICT(instrument) DO NOTHING").run(instrument, now);
      const r = this.db.prepare("SELECT result, claim_until FROM operations WHERE instrument = ?").get(instrument) as Row;
      if (r.result) return { state: "recorded", result: JSON.parse(String(r.result)) };
      const res = this.db.prepare("UPDATE operations SET claim_until = ?, claim_owner = ? WHERE instrument = ? AND result IS NULL AND (claim_until IS NULL OR claim_until < ?)")
        .run(now + ttlMs, owner, instrument, now);
      return Number(res.changes) === 1 ? { state: "claimed" } : { state: "busy" };
    });
  }

  releaseClaim(instrument: string, owner: string): void {
    this.db.prepare("UPDATE operations SET claim_until = NULL, claim_owner = NULL WHERE instrument = ? AND claim_owner = ?").run(instrument, owner);
  }

  /** Records the terminal result. A worker whose claim expired cannot record. */
  recordResult(instrument: string, owner: string, result: unknown, now: number): boolean {
    const res = this.db.prepare("UPDATE operations SET result = ?, claim_until = NULL WHERE instrument = ? AND claim_owner = ? AND result IS NULL AND claim_until >= ?")
      .run(JSON.stringify(result), instrument, owner, now);
    return Number(res.changes) === 1;
  }

  /** Marks an operation as executed by the resource server; true only for the first caller. */
  markExecuted(instrument: string, now: number): boolean {
    this.db.prepare("INSERT INTO operations (instrument, created_at) VALUES (?, ?) ON CONFLICT(instrument) DO NOTHING").run(instrument, now);
    const res = this.db.prepare("UPDATE operations SET executed_at = ? WHERE instrument = ? AND executed_at IS NULL").run(now, instrument);
    return Number(res.changes) === 1;
  }

  /** Replay guard for payment payloads: true the first time a hash is seen. */
  firstSeen(hash: string, now: number): boolean {
    const res = this.db.prepare("INSERT INTO seen_payloads (hash, ts) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING").run(hash, now);
    return Number(res.changes) === 1;
  }

  // ── kv ─────────────────────────────────────────────────────────────────

  getKv(k: string): string | undefined {
    const r = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as Row | undefined;
    return r ? String(r.v) : undefined;
  }

  setKv(k: string, v: string): void {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
}
