import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import {
  buyerHandle, log, type Endpoint, type Payment, type PaymentPayload, type PaymentRequired, type PaymentRequirements,
  type PenstockConfig, type ReceiptSigner, type ResourceInfo, type Seller, type SettleResponse, type SignedReceipt, type Store,
} from "@penstock/core";
import { clientAddress, headerValue, HttpError, readBody, sendJson, sendRaw } from "./http";
import type { MethodOutcome, PaymentMethodHandler } from "@penstock/core";
import type { RateLimiter } from "./ratelimit";
import { buildTargetUrl, filterRequestHeaders, forward, type UpstreamResult } from "./upstream";

export interface Delivery {
  /** Produces the paid response. Resale endpoints plug in here (they buy from upstream sellers first). */
  deliver(ctx: ProxyContext, endpoint: Endpoint, req: { method: string; headers: Record<string, string>; body: Buffer | null; subPath: string; search: string }, payment: Payment): Promise<UpstreamResult>;
}

export interface SessionGate {
  /** Meters one call against a session token; returns null when no session header was sent. */
  meter(ctx: ProxyContext, endpoint: Endpoint, token: string, buyer: string): Promise<{ ok: true; payment: Payment; headers: Record<string, string> } | { ok: false; status: number; error: string }>;
}

export interface ProxyContext {
  config: PenstockConfig;
  store: Store;
  methods: PaymentMethodHandler[];
  receipts: ReceiptSigner;
  limiter: RateLimiter;
  allowPrivateUpstreams: boolean;
  trustProxy: boolean;
  delivery: Delivery;
  sessions?: SessionGate;
  now(): number;
}

export const PAID_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, PENSTOCK-RECEIPT, PENSTOCK-SESSION-BALANCE",
  "access-control-allow-headers": "PAYMENT-SIGNATURE, PENSTOCK-SESSION, Content-Type, Accept",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export function resourceFor(ctx: ProxyContext, seller: Seller, endpoint: Endpoint): ResourceInfo {
  return {
    url: `${ctx.config.publicUrl}/p/${seller.id}/${endpoint.slug}`,
    description: endpoint.description,
    mimeType: "application/json",
    serviceName: seller.name,
    tags: endpoint.capabilities,
  };
}

export async function allOffers(ctx: ProxyContext, endpoint: Endpoint, seller: Seller, resource: ResourceInfo): Promise<PaymentRequirements[]> {
  const lists = await Promise.all(ctx.methods.map((m) => m.offers(endpoint, seller, resource)));
  return lists.flat();
}

export type Decision =
  | { type: "required"; paymentRequired: PaymentRequired; settle?: SettleResponse; retryAfter?: number }
  | { type: "paid"; payment: Payment; settle: SettleResponse; receipt: SignedReceipt };

function parsePayload(raw: unknown): PaymentPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as PaymentPayload;
  if (p.x402Version !== 2 || !p.accepted || typeof p.accepted !== "object" || !p.payload || typeof p.payload !== "object") return null;
  if (typeof p.accepted.scheme !== "string" || typeof p.accepted.network !== "string") return null;
  return p;
}

function recordProbe(ctx: ProxyContext, endpoint: Endpoint, buyer: string): void {
  const now = ctx.now();
  const last = ctx.store.latestProbe(endpoint.id, buyer);
  // One funnel entry per buyer visit: repeated 402s within 10 minutes count as the same probe.
  if (last && now - last.ts < 600_000 && last.stage !== "paid" && last.stage !== "refunded") return;
  ctx.store.insertProbe({ id: `prb_${randomUUID().slice(0, 12)}`, ts: now, endpointId: endpoint.id, buyer, originChain: null, stage: "probed", inferredReason: null, paymentId: null, simulated: ctx.config.mode !== "live" });
}

/**
 * The transport-independent paywall: given the payment the client presented (or none), decide
 * whether to ask for payment, return a quote, or let the call through. Server terms always come
 * from the server's own offers; the client's `accepted` is only used to pick one of them.
 */
export interface DecideOptions {
  /** Charge this instead of the per-call price (session funding). */
  priceUsdc?: string;
  /** Bind the payment to this resource instead of the endpoint's (session funding). */
  resource?: ResourceInfo;
  /** Ledger session id to attach to the settled payment. */
  sessionId?: string;
}

export async function decide(ctx: ProxyContext, seller: Seller, endpointIn: Endpoint, buyer: string, presented: unknown | null, opts: DecideOptions = {}): Promise<Decision> {
  const endpoint = opts.priceUsdc ? { ...endpointIn, priceUsdc: opts.priceUsdc } : endpointIn;
  const resource = opts.resource ?? resourceFor(ctx, seller, endpoint);
  const offers = await allOffers(ctx, endpoint, seller, resource);
  const required = (error: string | undefined, accepts = offers): PaymentRequired => ({ x402Version: 2, ...(error ? { error } : {}), resource, accepts });

  if (presented === null) {
    recordProbe(ctx, endpoint, buyer);
    return { type: "required", paymentRequired: required("payment required") };
  }
  const payload = parsePayload(presented);
  if (!payload) return { type: "required", paymentRequired: required("malformed PAYMENT-SIGNATURE: expected an x402 v2 PaymentPayload") };
  if (payload.resource?.url && payload.resource.url !== resource.url) {
    return { type: "required", paymentRequired: required("payment is for a different resource") };
  }
  const handler = ctx.methods.find((m) => m.owns(payload.accepted));
  if (!handler) return { type: "required", paymentRequired: required("unsupported scheme, network or asset transfer method") };
  const requirement = handler.match(payload.accepted, offers);
  if (!requirement) return { type: "required", paymentRequired: required("accepted terms do not match the current offer (price, payee or asset changed)") };

  let outcome: MethodOutcome;
  try {
    outcome = await handler.process(payload, requirement, { store: ctx.store, now: ctx.now, allow: (a) => ctx.limiter.take(a, buyer, ctx.now()) === 0 }, { endpoint, seller, buyer, resource });
  } catch (e) {
    log("error", "payment processing failed", { endpoint: endpoint.id, method: handler.id, error: (e as Error).message });
    return { type: "required", paymentRequired: required("payment could not be processed; try again") };
  }

  switch (outcome.kind) {
    case "quoted": {
      ctx.store.advanceProbe(endpoint.id, buyer, "quoted", { originChain: outcome.buyerChain });
      const accepts = offers.map((o) => (handler.match(o, [outcome.quoted]) ? outcome.quoted : o));
      return { type: "required", paymentRequired: required("quote issued: deposit to payTo, then retry with a deposit payload", accepts) };
    }
    case "pending":
      ctx.store.advanceProbe(endpoint.id, buyer, "deposited");
      return { type: "required", paymentRequired: required("settlement pending: retry with the same payload"), settle: outcome.settle, retryAfter: 5 };
    case "rejected":
      if (outcome.refund) {
        // Funds moved and were returned to the payer by 1Click: record the refund in the books.
        const { refundedAmount, refundReason, ...fields } = outcome.refund;
        const status = "refunded" as const;
        if (!fields.operationId || !ctx.store.paymentByOperation(fields.operationId)) {
          const id = `pay_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
          ctx.store.insertPayment({ id, ts: ctx.now(), sellerId: seller.id, endpointId: endpoint.id, status, ...fields, refundedAmount, refundReason, sessionId: null, upstreamCost: "0", simulated: handler.simulated, receiptSig: null });
          ctx.store.advanceProbe(endpoint.id, buyer, "refunded", { paymentId: id });
        }
      }
      return { type: "required", paymentRequired: required(`${outcome.reason}: ${outcome.message}`), settle: outcome.settle };
    case "settled": {
      if (!ctx.store.markExecuted(outcome.operationId, ctx.now())) {
        return { type: "required", paymentRequired: required("exact_near_intents_operation_executed: this payment was already redeemed"), settle: outcome.settle };
      }
      const payment: Payment = {
        id: `pay_${randomUUID().replace(/-/g, "").slice(0, 16)}`, ts: ctx.now(), sellerId: seller.id, endpointId: endpoint.id, status: "settled",
        ...outcome.fields, refundedAmount: null, refundReason: null, sessionId: opts.sessionId ?? null, upstreamCost: "0",
        simulated: handler.simulated, receiptSig: null,
      };
      const receipt = ctx.receipts.sign({
        v: 1, kind: opts.sessionId ? "session-funding" : "payment", paymentId: payment.id, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}), seller: seller.nearAccount, endpoint: endpoint.id, resource: resource.url,
        amountUsdc: payment.amountOut, network: outcome.settle.network, transaction: outcome.settle.transaction,
        originChain: payment.originChain, originTx: payment.originTx, payer: payment.payer, ts: payment.ts, simulated: payment.simulated,
      });
      payment.receiptSig = receipt.sig;
      ctx.store.insertPayment(payment);
      ctx.store.setKv(`receipt:${payment.id}`, JSON.stringify(receipt));
      ctx.store.advanceProbe(endpoint.id, buyer, "paid", { originChain: payment.originChain, paymentId: payment.id });
      return { type: "paid", payment, settle: outcome.settle, receipt };
    }
  }
}

export function encodeReceiptHeader(receipt: SignedReceipt): string {
  return Buffer.from(JSON.stringify(receipt)).toString("base64url");
}

export function buyerFor(ctx: ProxyContext, req: IncomingMessage): string {
  return buyerHandle(ctx.config.operationTokenSecret, [clientAddress(req, ctx.trustProxy), String(req.headers["user-agent"] ?? "")]);
}

function encodeReceipt(receipt: SignedReceipt): string {
  return Buffer.from(JSON.stringify(receipt)).toString("base64url");
}

export function requiredHeaders(d: Extract<Decision, { type: "required" }>): Record<string, string> {
  return {
    ...PAID_CORS_HEADERS,
    "PAYMENT-REQUIRED": encodePaymentRequiredHeader(d.paymentRequired),
    ...(d.settle ? { "PAYMENT-RESPONSE": encodePaymentResponseHeader(d.settle) } : {}),
    ...(d.retryAfter ? { "retry-after": String(d.retryAfter) } : {}),
  };
}

/** HTTP transport: `ANY /p/:seller/:slug/*`. */
export async function handleHttpPaid(ctx: ProxyContext, req: IncomingMessage, res: ServerResponse, seller: Seller, endpoint: Endpoint, subPath: string, search: string): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (!endpoint.methods.includes(method)) throw new HttpError(405, `method ${method} not allowed here`, "method_not_allowed");
  const buyer = buyerFor(ctx, req);
  const sessionToken = headerValue(req, "penstock-session");
  // Metered session calls have their own (higher) limit inside the session gate.
  if (!sessionToken) {
    const wait = ctx.limiter.take("request", buyer, ctx.now());
    if (wait) return sendJson(res, 429, { error: "rate limited" }, { ...PAID_CORS_HEADERS, "retry-after": String(wait) });
  }

  const body = method === "GET" || method === "HEAD" ? null : await readBody(req, 512 * 1024);
  const target = buildTargetUrl(endpoint, subPath, search);
  if (!target) throw new HttpError(400, "invalid path", "invalid_path");

  // Prepaid session: metered call, no per-call settlement.
  if (sessionToken && ctx.sessions) {
    const m = await ctx.sessions.meter(ctx, endpoint, sessionToken, buyer);
    if (!m.ok) return sendJson(res, m.status, { error: m.error }, PAID_CORS_HEADERS);
    return deliverHttp(ctx, res, endpoint, { method, headers: filterRequestHeaders(req.headers), body, subPath, search }, m.payment, m.headers);
  }

  const raw = headerValue(req, "payment-signature");
  let presented: unknown | null = null;
  if (raw !== undefined) {
    if (raw.length > 16_384) throw new HttpError(431, "PAYMENT-SIGNATURE header too large", "header_too_large");
    try {
      presented = decodePaymentSignatureHeader(raw);
    } catch {
      presented = { malformed: true };
    }
  }
  const d = await decide(ctx, seller, endpoint, buyer, presented);
  if (d.type === "required") return sendJson(res, 402, d.paymentRequired, requiredHeaders(d));

  return deliverHttp(ctx, res, endpoint, { method, headers: filterRequestHeaders(req.headers), body, subPath, search }, d.payment, {
    "PAYMENT-RESPONSE": encodePaymentResponseHeader(d.settle),
    "PENSTOCK-RECEIPT": encodeReceipt(d.receipt),
  });
}

async function deliverHttp(ctx: ProxyContext, res: ServerResponse, endpoint: Endpoint, req: Parameters<Delivery["deliver"]>[2], payment: Payment, paidHeaders: Record<string, string>): Promise<void> {
  try {
    const up = await ctx.delivery.deliver(ctx, endpoint, req, payment);
    sendRaw(res, up.status, up.body, { ...PAID_CORS_HEADERS, ...up.headers, ...paidHeaders, "x-content-type-options": "nosniff" });
  } catch (e) {
    // Under the upfront flow the receipt is returned even when the resource fails.
    log("warn", "upstream failed after payment", { endpoint: endpoint.id, paymentId: payment.id, error: (e as Error).message });
    sendJson(res, 502, { error: "upstream unavailable after payment", paymentId: payment.id, note: "The payment settled. Keep the PENSTOCK-RECEIPT header and contact the seller." }, { ...PAID_CORS_HEADERS, ...paidHeaders });
  }
}

/** Default delivery: forward to the endpoint's upstream. */
export const forwardDelivery: Delivery = {
  async deliver(ctx, endpoint, req) {
    const target = buildTargetUrl(endpoint, req.subPath, req.search);
    if (!target) throw new Error("invalid upstream target");
    return forward(target, req.method, req.headers, req.body, { allowPrivate: ctx.allowPrivateUpstreams });
  },
};

interface JsonRpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: { name?: string; arguments?: unknown; _meta?: Record<string, unknown> };
}

/** MCP transport (x402 transports-v2/mcp.md): payment travels in `params._meta["x402/payment"]`. */
export async function handleMcpPaid(ctx: ProxyContext, req: IncomingMessage, res: ServerResponse, seller: Seller, endpoint: Endpoint): Promise<void> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") throw new HttpError(405, "MCP endpoints accept POST", "method_not_allowed");
  const buyer = buyerFor(ctx, req);
  const wait = ctx.limiter.take("request", buyer, ctx.now());
  if (wait) return sendJson(res, 429, { error: "rate limited" }, { ...PAID_CORS_HEADERS, "retry-after": String(wait) });

  const raw = await readBody(req, 256 * 1024);
  let msg: JsonRpc;
  try {
    msg = JSON.parse(raw.toString("utf8")) as JsonRpc;
  } catch {
    return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });

  const target = buildTargetUrl(endpoint, "", "");
  if (!target) throw new HttpError(500, "invalid upstream", "invalid_upstream");
  const forwardRpc = async (m: JsonRpc) => forward(target, "POST", { "content-type": "application/json" }, Buffer.from(JSON.stringify(m)), { allowPrivate: ctx.allowPrivateUpstreams });

  // Discovery calls are free; only tool calls are paid.
  if (msg.method !== "tools/call") {
    const up = await forwardRpc(msg);
    return sendRaw(res, up.status, up.body, { ...PAID_CORS_HEADERS, "content-type": "application/json" });
  }

  const meta = msg.params?._meta ?? {};
  const sessionToken = typeof meta["penstock/session"] === "string" ? (meta["penstock/session"] as string) : undefined;
  let payment: Payment;
  let paymentResponse: Record<string, unknown>;
  if (sessionToken && ctx.sessions) {
    const m = await ctx.sessions.meter(ctx, endpoint, sessionToken, buyer);
    if (!m.ok) return sendJson(res, 200, { jsonrpc: "2.0", id: msg.id ?? null, result: { isError: true, content: [{ type: "text", text: m.error }] } });
    payment = m.payment;
    paymentResponse = { session: m.headers["PENSTOCK-SESSION-BALANCE"] ?? null };
  } else {
    const presented = meta["x402/payment"] ?? null;
    const d = await decide(ctx, seller, endpoint, buyer, presented);
    if (d.type === "required") {
      return sendJson(res, 200, {
        jsonrpc: "2.0", id: msg.id ?? null,
        result: { isError: true, structuredContent: d.paymentRequired, content: [{ type: "text", text: JSON.stringify(d.paymentRequired) }], ...(d.settle ? { _meta: { "x402/payment-response": d.settle } } : {}) },
      });
    }
    payment = d.payment;
    paymentResponse = { ...d.settle, receipt: d.receipt };
  }

  const { _meta: _drop, ...params } = msg.params ?? {};
  try {
    const up = await forwardRpc({ ...msg, params });
    const parsed = JSON.parse(up.body.toString("utf8")) as { result?: Record<string, unknown>; error?: unknown };
    const result = { ...(parsed.result ?? { isError: true, content: [{ type: "text", text: "upstream error" }] }), _meta: { "x402/payment-response": paymentResponse } };
    return sendJson(res, 200, { jsonrpc: "2.0", id: msg.id ?? null, result }, PAID_CORS_HEADERS);
  } catch (e) {
    log("warn", "mcp upstream failed after payment", { endpoint: endpoint.id, paymentId: payment.id, error: (e as Error).message });
    return sendJson(res, 200, { jsonrpc: "2.0", id: msg.id ?? null, result: { isError: true, content: [{ type: "text", text: `upstream unavailable after payment ${payment.id}` }], _meta: { "x402/payment-response": paymentResponse } } });
  }
}
