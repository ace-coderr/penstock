import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import {
  formatUnits, isValidNearAccount, log, parseUnits, sha256Hex,
  type Endpoint, type Payment, type ResourceInfo, type Seller, type Session, type SignedReceipt,
} from "@penstock/core";
import { headerValue, HttpError, sendJson } from "./http";
import { buyerFor, decide, encodeReceiptHeader, PAID_CORS_HEADERS, requiredHeaders, type ProxyContext, type SessionGate } from "./paywall";

/**
 * Prepaid sessions for micro-calls. One x402 payment (any rail) funds a session up to a hard cap;
 * calls are metered against it without a per-call settlement; metered spend is settled in batches;
 * the unused balance is refunded on close or expiry.
 *
 * Trust model: the funding payment goes to the seller's account, so the seller holds session
 * funds (at most the cap) until close. The buyer holds a signed session receipt at every step.
 */

export const SESSION_TTL_MS = 24 * 3_600_000;
const BATCH_EVERY_CALLS = 25;
const MAX_OPEN_PER_BUYER = 3;
const TOKEN = /^(ses_[0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;

export function sessionReceiptBody(ctx: ProxyContext, s: Session, seller: Seller, calls: number, fundingTx: string | null) {
  return {
    v: 1, kind: "session", sessionId: s.id, seller: seller.nearAccount, endpoint: s.endpointId, status: s.status,
    capUsdc: s.capUsdc, fundedUsdc: s.fundedUsdc, spentUsdc: s.spentUsdc, settledUsdc: s.settledUsdc, calls,
    refundUsdc: s.refundUsdc, refundTo: s.refundTo, refundState: s.refundState ?? "none", refundTx: s.refundTx ?? null,
    openedAt: s.openedAt, closedAt: s.closedAt, expiresAt: s.expiresAt ?? null, fundingPaymentId: s.fundingPaymentId, fundingTx,
    simulated: s.simulated, issuedAt: ctx.now(),
  };
}

export class SessionManager implements SessionGate {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: ProxyContext) {}

  get capUsdc(): bigint {
    return parseUnits(this.ctx.config.sessionCapUsd, 6);
  }

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private authenticate(token: string): (Session & { secretHash: string }) | null {
    const m = TOKEN.exec(token.trim());
    if (!m) return null;
    const s = this.ctx.store.getSession(m[1]!);
    if (!s) return null;
    const given = Buffer.from(sha256Hex(m[2]!), "hex");
    const want = Buffer.from(s.secretHash, "hex");
    return given.length === want.length && timingSafeEqual(given, want) ? s : null;
  }

  async meter(ctx: ProxyContext, endpoint: Endpoint, token: string, buyer: string) {
    if (ctx.limiter.take("session", buyer, ctx.now())) return { ok: false as const, status: 429, error: "rate limited" };
    const s = this.authenticate(token);
    if (!s) return { ok: false as const, status: 401, error: "unknown or invalid session token" };
    if (s.endpointId !== endpoint.id) return { ok: false as const, status: 403, error: "this session is for a different endpoint" };
    if (s.status !== "open") return { ok: false as const, status: 410, error: "session is closed" };
    if (s.expiresAt && s.expiresAt < ctx.now()) {
      this.close(s.id);
      return { ok: false as const, status: 410, error: "session expired; unused balance refunded" };
    }
    const price = BigInt(endpoint.priceUsdc);
    if (!ctx.store.meterSessionCall(s.id, price, ctx.now())) return { ok: false as const, status: 402, error: "session balance exhausted: close it and open a new one" };
    const after = ctx.store.getSession(s.id)!;
    const unbatched = ctx.store.sessionCalls(s.id).filter((c) => !c.batchId).length;
    if (unbatched >= BATCH_EVERY_CALLS) ctx.store.settleSessionBatch(s.id, `bat_${randomUUID().slice(0, 12)}`);
    const payment = ctx.store.getPayment(s.fundingPaymentId) as Payment;
    const remaining = BigInt(after.fundedUsdc) - BigInt(after.spentUsdc);
    return { ok: true as const, payment, headers: { "PENSTOCK-SESSION-BALANCE": `remaining=${remaining}; spent=${after.spentUsdc}; funded=${after.fundedUsdc}` } };
  }

  /** Closes a session once: settles the last batch and refunds the unused balance. */
  close(id: string): Session | null {
    const { store, config } = this.ctx;
    store.settleSessionBatch(id, `bat_${randomUUID().slice(0, 12)}`);
    const refund = store.closeSession(id, this.ctx.now());
    if (refund === null) return null;
    if (refund > 0n) {
      if (config.mode === "live") {
        // Penstock holds no seller keys: in live mode the seller sends the refund (shown in the console).
        store.setSessionRefund(id, "owed", null);
      } else {
        store.setSessionRefund(id, "simulated", `sim:${createHash("sha256").update(`refund:${id}`).digest("hex").slice(0, 44)}`);
      }
    }
    log("info", "session closed", { session: id, refundUsdc: refund.toString() });
    return store.getSession(id) ?? null;
  }

  sweep(): void {
    for (const w of this.ctx.store.sessionsNeedingWork(this.ctx.now())) {
      if (w.expired) this.close(w.id);
      else this.ctx.store.settleSessionBatch(w.id, `bat_${randomUUID().slice(0, 12)}`);
    }
  }

  receipt(s: Session, seller: Seller): SignedReceipt {
    const calls = this.ctx.store.sessionCalls(s.id).length;
    const funding = this.ctx.store.getPayment(s.fundingPaymentId);
    return this.ctx.receipts.sign(sessionReceiptBody(this.ctx, s, seller, calls, funding?.destTx ?? null));
  }

  /** `/s/:seller/:slug/{open/:amount|status|close}` */
  async handle(req: IncomingMessage, res: ServerResponse, seller: Seller, endpoint: Endpoint, action: string, arg: string | undefined, url: URL): Promise<void> {
    const ctx = this.ctx;
    if (req.method === "OPTIONS") return sendJson(res, 204, {}, PAID_CORS_HEADERS);
    if (!endpoint.sessionsEnabled) throw new HttpError(404, "sessions are not enabled for this endpoint", "sessions_disabled");
    const buyer = buyerFor(ctx, req);

    if (action === "open") {
      if (!arg || !/^\d{1,12}$/.test(arg)) throw new HttpError(400, "open/<amount in USDC base units>, e.g. open/2000000 for $2", "invalid_amount");
      const amount = BigInt(arg);
      const price = BigInt(endpoint.priceUsdc);
      if (amount < price) throw new HttpError(400, `minimum session funding is one call (${endpoint.priceUsdc})`, "below_minimum");
      if (amount > this.capUsdc) throw new HttpError(400, `session cap is ${formatUnits(this.capUsdc, 6)} USDC`, "above_cap");
      const refundTo = url.searchParams.get("refundTo") ?? "";
      if (refundTo && !isValidNearAccount(refundTo)) throw new HttpError(400, "refundTo must be a NEAR account", "invalid_refund_to");
      const raw = headerValue(req, "payment-signature");
      if (raw && ctx.store.openSessionCount(endpoint.id, buyer) >= MAX_OPEN_PER_BUYER) throw new HttpError(429, `at most ${MAX_OPEN_PER_BUYER} open sessions per buyer and endpoint`, "too_many_sessions");
      let presented: unknown = null;
      if (raw !== undefined) {
        if (raw.length > 16_384) throw new HttpError(431, "PAYMENT-SIGNATURE header too large", "header_too_large");
        try {
          presented = decodePaymentSignatureHeader(raw);
        } catch {
          presented = { malformed: true };
        }
      }
      const resource: ResourceInfo = { url: `${ctx.config.publicUrl}/s/${seller.id}/${endpoint.slug}/open/${amount}`, description: `Prepaid session for ${endpoint.id}: ${formatUnits(amount, 6)} USDC, ${amount / price} calls`, mimeType: "application/json", serviceName: seller.name };
      const id = `ses_${randomBytes(8).toString("hex")}`;
      const d = await decide(ctx, seller, endpoint, buyer, presented, { priceUsdc: amount.toString(), resource, sessionId: id });
      if (d.type === "required") return sendJson(res, 402, d.paymentRequired, requiredHeaders(d));

      const secret = randomBytes(32).toString("base64url");
      const now = ctx.now();
      const session: Session = {
        id, sellerId: seller.id, endpointId: endpoint.id, buyer, capUsdc: this.capUsdc.toString(), fundedUsdc: amount.toString(),
        spentUsdc: "0", settledUsdc: "0", status: "open", openedAt: now, closedAt: null, refundUsdc: null, fundingPaymentId: d.payment.id,
        refundTo: refundTo || d.payment.payer, originChain: d.payment.originChain, simulated: d.payment.simulated,
      };
      ctx.store.insertSession(session, sha256Hex(secret));
      ctx.store.setSessionExpiry(id, now + SESSION_TTL_MS);
      const stored = ctx.store.getSession(id)!;
      const receipt = this.receipt(stored, seller);
      return sendJson(res, 200, {
        session: { id, token: `${id}.${secret}`, endpoint: endpoint.id, fundedUsdc: session.fundedUsdc, capUsdc: session.capUsdc, pricePerCallUsdc: endpoint.priceUsdc, calls: Number(amount / price), expiresAt: now + SESSION_TTL_MS, refundTo: session.refundTo },
        usage: `Send the token in the PENSTOCK-SESSION header on ${ctx.config.publicUrl}/p/${seller.id}/${endpoint.slug}. Close with POST ${ctx.config.publicUrl}/s/${seller.id}/${endpoint.slug}/close.`,
        receipt,
        simulated: session.simulated,
      }, { ...PAID_CORS_HEADERS, "PAYMENT-RESPONSE": encodePaymentResponseHeader(d.settle), "PENSTOCK-RECEIPT": encodeReceiptHeader(d.receipt) });
    }

    const token = headerValue(req, "penstock-session") ?? "";
    const s = this.authenticate(token);
    if (!s || s.endpointId !== endpoint.id) throw new HttpError(401, "send a valid session token in PENSTOCK-SESSION", "invalid_session");

    if (action === "status" && req.method === "GET") {
      return sendJson(res, 200, { receipt: this.receipt(s, seller) }, PAID_CORS_HEADERS);
    }
    if (action === "close" && req.method === "POST") {
      const closed = this.close(s.id) ?? ctx.store.getSession(s.id)!;
      return sendJson(res, 200, { receipt: this.receipt(closed, seller) }, PAID_CORS_HEADERS);
    }
    throw new HttpError(405, "use GET status or POST close", "method_not_allowed");
  }
}
