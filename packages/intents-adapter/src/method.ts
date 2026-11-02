import { randomUUID } from "node:crypto";
import {
  CHAINS, DESTINATION, chainByCaip2, assetOn, formatUnits, isValidAddress, log,
  type AssetInfo, type ChainInfo, type Endpoint, type MethodContext, type MethodMeta, type MethodOutcome, type PaymentMethodHandler,
  type PaymentPayload, type PaymentRequirements, type ResourceInfo, type Seller, type SettleResponse,
} from "@penstock/core";
import { OneClickError, TERMINAL_STATUSES, parseRouteMinimum, type Confidentiality, type OneClick, type QuoteRequest, type StatusResponse } from "./oneclick";
import { mintOperationToken, verifyOperationToken, type Destination, type KeyRing } from "./token";
import type { IndicativePricer } from "./pricing";

/**
 * x402 `exact` with `extra.assetTransferMethod: "near-intents"` and `paymentFlow: "upfront"`.
 * The wire shape follows an unofficial community draft where it helps (no conformance claim);
 * settlement uses the documented 1Click Swap API.
 * Penstock acts as both resource server and facilitator for this method. Funds go from the
 * buyer's origin chain into a single-use 1Click deposit address and are delivered as USDC
 * directly to the seller's NEAR account; failed swaps are refunded by 1Click to `refundTo`.
 */

export const NEAR_INTENTS = "near-intents";
const GRACE_SEC = 24 * 3600;

export interface ConfidentialityChooser {
  /** Returns the confidentiality level to request, or "public" when shielded mode is off. */
  level(): Confidentiality;
  /** Called when 1Click refuses a confidential quote, so later quotes stop asking for it. */
  unavailable?(reason: string): void;
}

export interface NearIntentsOptions {
  oneClick: OneClick;
  keys: KeyRing;
  pricer: IndicativePricer;
  simulated: boolean;
  slippage?: { min: number; max: number; default: number };
  settleWindowMs?: number;
  pollIntervalMs?: number;
  confidentiality?: ConfidentialityChooser;
  /** Checks the seller's payout account before quoting (1Click rejects missing NEAR accounts). */
  recipientCheck?: (account: string) => Promise<{ ok: boolean; message: string }>;
  /** Origins to offer; defaults to every registry asset except NEAR USDC (paid via `exact`). */
  origins?: { chain: ChainInfo; asset: AssetInfo }[];
}

export function defaultOrigins(): { chain: ChainInfo; asset: AssetInfo }[] {
  return CHAINS.flatMap((chain) => chain.assets.map((asset) => ({ chain, asset }))).filter(({ chain, asset }) => !(chain.key === "near" && asset.symbol === "USDC"));
}

interface QuotedRecord {
  unquoted: PaymentRequirements;
  resource: string;
  sellerId: string;
  endpointId: string;
  buyer: string;
  refundTo: string;
  amountInUsd: string;
  amountOutUsd: string;
  timeEstimate: number;
  confidentiality: Confidentiality;
}

function instrumentOf(network: string, depositAddress: string, memo?: string): string {
  return `${network}:${depositAddress}${memo ? `:${memo}` : ""}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class NearIntentsMethod implements PaymentMethodHandler {
  readonly id = "near-intents" as const;
  readonly simulated: boolean;
  private readonly o: Required<Omit<NearIntentsOptions, "confidentiality" | "recipientCheck">> & Pick<NearIntentsOptions, "confidentiality" | "recipientCheck">;

  constructor(opts: NearIntentsOptions) {
    this.simulated = opts.simulated;
    this.o = {
      slippage: { min: 10, max: 500, default: 100 },
      settleWindowMs: opts.oneClick.kind === "http" ? 25_000 : 8_000,
      pollIntervalMs: opts.oneClick.kind === "http" ? 2_000 : 250,
      origins: defaultOrigins(),
      ...opts,
    };
  }

  get slippage() {
    return this.o.slippage;
  }

  async offers(endpoint: Endpoint, seller: Seller, _resource: ResourceInfo): Promise<PaymentRequirements[]> {
    const destination: Destination = { network: DESTINATION.network, asset: DESTINATION.asset, amount: endpoint.priceUsdc, recipient: seller.nearAccount };
    return this.o.origins.map(({ chain, asset }) => {
      const indicative = this.o.pricer.indicative(asset, BigInt(endpoint.priceUsdc));
      return {
        scheme: "exact", network: chain.caip2, amount: "", asset: asset.x402Asset, payTo: "", maxTimeoutSeconds: chain.depositWindowSec,
        extra: { assetTransferMethod: NEAR_INTENTS, paymentFlow: "upfront", ...(indicative ? { indicativeAmount: indicative } : {}), destination },
      };
    });
  }

  owns(accepted: PaymentRequirements): boolean {
    return accepted?.scheme === "exact" && accepted.extra?.assetTransferMethod === NEAR_INTENTS;
  }

  match(accepted: PaymentRequirements, offers: PaymentRequirements[]): PaymentRequirements | null {
    return offers.find((o) => this.owns(o) && o.network === accepted.network && o.asset.toLowerCase() === String(accepted.asset).toLowerCase()) ?? null;
  }

  async process(payload: PaymentPayload, req: PaymentRequirements, ctx: MethodContext, meta: MethodMeta): Promise<MethodOutcome> {
    const p = payload.payload as Record<string, unknown>;
    if (!payload.resource?.url) return { kind: "rejected", reason: "invalid_payload", message: "near-intents payloads must carry resource.url" };
    if (p.type === "quote") return this.quote(p, req, ctx, meta);
    if (p.type === "deposit") return this.settle(p, req, ctx, meta);
    return { kind: "rejected", reason: "invalid_payload", message: "payload.type must be \"quote\" or \"deposit\"" };
  }

  // ── /verify: mint a quote ──────────────────────────────────────────────

  private async quote(p: Record<string, unknown>, req: PaymentRequirements, ctx: MethodContext, meta: MethodMeta): Promise<MethodOutcome> {
    const chain = chainByCaip2(req.network);
    const asset = chain && assetOn(chain, req.asset);
    if (!chain || !asset) return { kind: "rejected", reason: "invalid_exact_near_intents_quote_unavailable", message: "origin not offered" };
    const refundTo = typeof p.refundTo === "string" ? p.refundTo.trim() : "";
    if (!isValidAddress(chain, refundTo)) return { kind: "rejected", reason: "invalid_payload", message: `refundTo must be a valid ${chain.label} address (e.g. ${chain.addressExample})` };
    if (ctx.allow && !ctx.allow("quote")) return { kind: "rejected", reason: "rate_limited", message: "too many quote requests; slow down" };

    const dest0 = req.extra.destination as Destination;
    if (this.o.recipientCheck) {
      const rc = await this.o.recipientCheck(dest0.recipient);
      if (!rc.ok) return { kind: "rejected", reason: "invalid_exact_near_intents_quote_unavailable", message: rc.message };
    }
    const s = this.o.slippage;
    const asked = typeof p.slippageTolerance === "number" && Number.isFinite(p.slippageTolerance) ? Math.round(p.slippageTolerance) : s.default;
    const slippageTolerance = Math.min(s.max, Math.max(s.min, asked));
    const dest = req.extra.destination as Destination;
    const now = ctx.now();
    const deadlineMs = now + req.maxTimeoutSeconds * 1000;
    let confidentiality = this.o.confidentiality?.level() ?? "public";
    const qreq: QuoteRequest = {
      dry: false, swapType: "EXACT_OUTPUT", slippageTolerance, originAsset: asset.oneClickAssetId, depositType: "ORIGIN_CHAIN", depositMode: "SIMPLE",
      destinationAsset: DESTINATION.oneClickAssetId, amount: dest.amount, refundTo, refundType: "ORIGIN_CHAIN",
      recipient: dest.recipient, recipientType: "DESTINATION_CHAIN", deadline: new Date(deadlineMs).toISOString(),
      ...(confidentiality !== "public" ? { confidentiality } : {}),
    };
    let quote;
    try {
      try {
        quote = await this.o.oneClick.quote(qreq);
      } catch (e) {
        // Shielded mode degrades gracefully: without 1Click auth, pay with a public quote instead of failing.
        if (confidentiality === "public" || !(e instanceof OneClickError) || e.status !== 401) throw e;
        this.o.confidentiality?.unavailable?.(e.message);
        log("warn", "confidential quote refused by 1Click; falling back to a public quote", { status: e.status });
        confidentiality = "public";
        delete qreq.confidentiality;
        quote = await this.o.oneClick.quote(qreq);
      }
    } catch (e) {
      const msg = e instanceof OneClickError ? e.message : "1Click unavailable";
      const min = parseRouteMinimum(msg);
      if (min !== null) {
        return {
          kind: "rejected", reason: "invalid_exact_near_intents_quote_unavailable",
          message: `below the ${chain.label} route minimum of ${formatUnits(min, DESTINATION.decimals)} USDC; fund a prepaid session of at least that amount, or pay from NEAR`,
        };
      }
      return { kind: "rejected", reason: "invalid_exact_near_intents_quote_unavailable", message: msg };
    }
    // The echoed request must carry our destination terms; anything else is not our quote.
    const echo = quote.quoteRequest;
    if (echo.recipient !== dest.recipient || echo.destinationAsset !== DESTINATION.oneClickAssetId || echo.amount !== dest.amount || echo.swapType !== "EXACT_OUTPUT") {
      return { kind: "rejected", reason: "invalid_exact_near_intents_quote_unavailable", message: "1Click quote does not match the destination terms" };
    }
    const depositAddress = quote.quote.depositAddress!;
    const depositMemo = quote.quote.depositMemo;
    const refundDeadline = new Date(deadlineMs).toISOString();
    const expiry = Math.floor(deadlineMs / 1000) + GRACE_SEC;
    const operationToken = mintOperationToken(this.o.keys, { network: req.network, depositAddress, depositMemo, resource: meta.resource.url, destination: dest }, expiry);
    const record: QuotedRecord = {
      unquoted: req, resource: meta.resource.url, sellerId: meta.seller.id, endpointId: meta.endpoint.id, buyer: meta.buyer, refundTo,
      amountInUsd: quote.quote.amountInUsd, amountOutUsd: quote.quote.amountOutUsd, timeEstimate: quote.quote.timeEstimate, confidentiality,
    };
    ctx.store.recordQuotedOperation(instrumentOf(req.network, depositAddress, depositMemo), record, now);
    const quoted: PaymentRequirements = {
      ...req, amount: quote.quote.amountIn, payTo: depositAddress,
      extra: { ...req.extra, refundDeadline, operationToken, ...(depositMemo ? { depositMemo } : {}) },
    };
    return { kind: "quoted", quoted, buyerChain: chain.key };
  }

  // ── /settle: confirm delivery to the seller ────────────────────────────

  private async settle(p: Record<string, unknown>, req: PaymentRequirements, ctx: MethodContext, meta: MethodMeta): Promise<MethodOutcome> {
    const chain = chainByCaip2(req.network)!;
    const asset = assetOn(chain, req.asset)!;
    const depositAddress = typeof p.depositAddress === "string" ? p.depositAddress : "";
    const depositMemo = typeof p.depositMemo === "string" ? p.depositMemo : undefined;
    const txHash = typeof p.txHash === "string" ? p.txHash : "";
    const txOk = this.simulated ? /^sim:[0-9a-zA-Z]{16,128}$/.test(txHash) || /^(0x)?[0-9a-fA-F]{64}$/.test(txHash) : /^[0-9a-zA-Z]{16,128}$/.test(txHash.replace(/^0x/, "")) && !txHash.startsWith("sim");
    if (!depositAddress || depositAddress.length > 128 || !txOk) {
      return { kind: "rejected", reason: "invalid_payload", message: "deposit payload needs operationToken, depositAddress and a well-formed txHash" };
    }
    const instrument = instrumentOf(req.network, depositAddress, depositMemo);
    const op = ctx.store.getQuotedOperation(instrument);
    const record = (op?.quotedEntry ?? null) as QuotedRecord | null;
    // Terms recorded at quote time win over the current config, so later price changes do not break old quotes.
    const terms = record?.unquoted ?? req;
    const dest = terms.extra.destination as Destination;
    const check = verifyOperationToken(this.o.keys, p.operationToken, { network: req.network, depositAddress, depositMemo, resource: meta.resource.url, destination: dest }, Math.floor(ctx.now() / 1000));
    if (!check.ok) return { kind: "rejected", reason: check.reason, message: check.reason === "invalid_exact_near_intents_token_expired" ? "operation token expired" : "operation token does not verify for this resource and deposit" };
    if (op?.result) return this.replay(op.result as SettleResponse, record, req, chain, asset, instrument, depositAddress, txHash);

    let status: StatusResponse;
    try {
      status = await this.o.oneClick.status(depositAddress, depositMemo);
    } catch (e) {
      if (e instanceof OneClickError && e.status === 404) return { kind: "rejected", reason: "invalid_exact_near_intents_deposit_not_found", message: "deposit address unknown to 1Click" };
      return { kind: "pending", settle: this.pending(req.network, txHash, "UNKNOWN") };
    }
    const qr = status.quoteResponse.quoteRequest;
    if (qr.recipient !== dest.recipient || qr.destinationAsset !== DESTINATION.oneClickAssetId || qr.amount !== dest.amount) {
      return { kind: "rejected", reason: "invalid_exact_near_intents_quote_mismatch", message: "1Click quote terms do not match the seller's destination" };
    }

    const owner = randomUUID();
    const claim = ctx.store.claimOperation(instrument, owner, this.o.settleWindowMs + 30_000, ctx.now());
    if (claim.state === "busy") return { kind: "pending", settle: this.pending(req.network, txHash, status.status) };
    if (claim.state === "recorded") return this.replay(claim.result as SettleResponse, record, req, chain, asset, instrument, depositAddress, txHash);

    try {
      await this.o.oneClick.submitDeposit({ txHash, depositAddress, ...(depositMemo ? { memo: depositMemo } : {}) }).catch(() => undefined);
      const until = ctx.now() + this.o.settleWindowMs;
      while (!TERMINAL_STATUSES.has(status.status) && ctx.now() < until) {
        await sleep(this.o.pollIntervalMs);
        status = await this.o.oneClick.status(depositAddress, depositMemo);
      }
      const d = status.swapDetails;
      const known = d.originChainTxHashes.some((t) => t.hash.toLowerCase() === txHash.toLowerCase());
      if (status.status === "SUCCESS" && !known) {
        ctx.store.releaseClaim(instrument, owner);
        return { kind: "rejected", reason: "invalid_exact_near_intents_deposit_not_found", message: "txHash is not a deposit of this operation" };
      }
      if (!TERMINAL_STATUSES.has(status.status)) {
        ctx.store.releaseClaim(instrument, owner);
        return { kind: "pending", settle: this.pending(req.network, txHash, status.status) };
      }
      const refundTo = qr.refundTo;
      const amountInUsd = Number(d.amountInUsd ?? status.quoteResponse.quote.amountInUsd);
      const amountOutUsd = Number(d.amountOutUsd ?? status.quoteResponse.quote.amountOutUsd);
      const shielded = (qr.confidentiality ?? "public") !== "public";
      const base = {
        method: "near-intents" as const, originChain: chain.key, originAsset: asset.x402Asset, originSymbol: asset.symbol,
        amountIn: d.amountIn ?? d.depositedAmount ?? status.quoteResponse.quote.amountIn, amountInUsd, amountOut: dest.amount,
        feeUsd: Math.max(0, Number((amountInUsd - amountOutUsd).toFixed(6))), payer: refundTo, refundTo, depositAddress,
        originTx: txHash, operationId: instrument, shielded,
      };
      if (status.status === "SUCCESS") {
        const destTx = d.destinationChainTxHashes[0]?.hash ?? d.nearTxHashes[0] ?? "";
        const settle: SettleResponse = { success: true, network: DESTINATION.network, transaction: destTx, payer: refundTo, amount: dest.amount, extra: { originNetwork: req.network, originTxHash: txHash } };
        ctx.store.recordResult(instrument, owner, settle, ctx.now());
        return { kind: "settled", settle, operationId: instrument, fields: { ...base, destTx } };
      }
      const partial = d.refundReason === "PARTIAL_DEPOSIT";
      const settle: SettleResponse = {
        success: false, errorReason: partial ? "exact_near_intents_insufficient_deposit" : "exact_near_intents_payment_failed",
        network: req.network, transaction: "", extra: { status: status.status, refundTo },
      };
      ctx.store.recordResult(instrument, owner, settle, ctx.now());
      log("info", "near-intents payment refunded to payer", { endpoint: meta.endpoint.id, status: status.status, reason: d.refundReason ?? null });
      return {
        kind: "rejected", reason: settle.errorReason!, message: `${status.status}: funds are returned by 1Click to ${refundTo}`, settle,
        refund: { ...base, destTx: null, refundedAmount: d.refundedAmount ?? d.depositedAmount ?? null, refundReason: d.refundReason ?? status.status },
      };
    } catch (e) {
      ctx.store.releaseClaim(instrument, owner);
      log("warn", "near-intents settlement error", { error: (e as Error).message });
      return { kind: "pending", settle: this.pending(req.network, txHash, "UNKNOWN") };
    }
  }

  private pending(network: string, txHash: string, status: string): SettleResponse {
    return { success: false, errorReason: "settlement_pending", network: network as SettleResponse["network"], transaction: txHash, extra: { status } };
  }

  /** A recorded result is returned unchanged; a success here means the operation was already redeemed. */
  private replay(result: SettleResponse, record: QuotedRecord | null, req: PaymentRequirements, chain: ChainInfo, asset: AssetInfo, instrument: string, depositAddress: string, txHash: string): MethodOutcome {
    if (!result.success) return { kind: "rejected", reason: result.errorReason ?? "exact_near_intents_payment_failed", message: "this operation already failed and was refunded", settle: result };
    const dest = (record?.unquoted ?? req).extra.destination as Destination;
    return {
      kind: "settled", settle: result, operationId: instrument,
      fields: {
        method: "near-intents", originChain: chain.key, originAsset: asset.x402Asset, originSymbol: asset.symbol, amountIn: "0", amountInUsd: 0, amountOut: dest.amount,
        feeUsd: 0, payer: result.payer ?? "", refundTo: record?.refundTo ?? "", depositAddress, originTx: txHash, destTx: result.transaction, operationId: instrument, shielded: false,
      },
    };
  }
}
