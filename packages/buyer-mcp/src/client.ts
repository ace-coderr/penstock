import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { CHAINS, assetOn, chainByKey, formatUnits, type PaymentPayload, type PaymentRequired, type PaymentRequirements, type SettleResponse } from "@penstock/core";
import {
  buildDepositPayload, buildQuotePayload, depositInstructions, findQuotedEntry, isUnquoted, type DepositInstructions, type Holding, type RankedRoute,
} from "@penstock/intents-adapter";
import { buildExactPayload, isExactNear } from "./exact";
import type { NearWallet } from "./near-wallet";

/**
 * A buyer for Penstock-protected endpoints. It finds sellers through `/.well-known/penstock.json`,
 * answers 402s on its own, and pays from whichever of its holdings is cheapest: USDC on NEAR
 * directly, or any other chain and token through NEAR Intents.
 */

export interface OriginWallet {
  chain: string;
  address: string;
  simulated: boolean;
  /** Sends `amount` of `asset` to `payTo` on this chain and returns the transaction hash. */
  deposit(d: DepositInstructions): Promise<string>;
}

/** Demo/dry only: "transfers" by telling the proxy's simulated 1Click backend about a deposit. */
export function simulatedOriginWallet(chain: string, proxyBase: string): OriginWallet {
  const info = chainByKey(chain);
  if (!info) throw new Error(`unknown chain ${chain}`);
  return {
    chain, address: info.addressExample, simulated: true,
    async deposit(d) {
      const r = await fetch(`${proxyBase}/sim/deposit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ depositAddress: d.payTo, amount: d.amount }) });
      if (!r.ok) throw new Error(`simulated deposit failed: HTTP ${r.status}`);
      return ((await r.json()) as { txHash: string }).txHash;
    },
  };
}

export interface ListedEndpoint {
  id: string;
  url: string;
  seller: string;
  sellerName: string;
  kind: string;
  description: string;
  capabilities: string[];
  priceUsd: string;
  priceUsdc: string;
  sessions: boolean;
  simulated: boolean;
  directory: string;
}

export interface PaidResult {
  status: number;
  body: unknown;
  paid: boolean;
  method?: "exact-near" | "near-intents";
  originChain?: string;
  originSymbol?: string;
  amountIn?: string;
  settlement?: SettleResponse;
  receipt?: unknown;
  /** Set when a live deposit is needed and no origin wallet can make it. */
  depositRequired?: { resumeId: string; instructions: DepositInstructions };
  note?: string;
}

export interface BuyerOptions {
  directories: string[];
  holdings: Holding[];
  near?: NearWallet;
  origins?: OriginWallet[];
  fetchImpl?: typeof fetch;
  /** settlement_pending retries with the same payload. */
  pendingRetries?: number;
}

interface Pending {
  url: string;
  init: RequestInit;
  required: PaymentRequired;
  unquoted: PaymentRequirements;
  instructions: DepositInstructions;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PenstockBuyer {
  private readonly f: typeof fetch;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly o: BuyerOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  /** Searches every directory for endpoints matching a capability word and a price ceiling. */
  async search(capability?: string, maxPriceUsd?: number): Promise<ListedEndpoint[]> {
    const out: ListedEndpoint[] = [];
    for (const dir of this.o.directories) {
      try {
        const doc = (await (await this.f(dir)).json()) as { simulated: boolean; sellers: { id: string; name: string; endpoints: { id: string; url: string; kind: string; description: string; capabilities: string[]; priceUsd: string; priceUsdc: string; sessions: unknown }[] }[] };
        for (const s of doc.sellers) {
          for (const e of s.endpoints) {
            const cap = capability?.toLowerCase().trim();
            const hit = !cap || e.capabilities.some((c) => c.includes(cap)) || e.description.toLowerCase().includes(cap);
            if (!hit || (maxPriceUsd !== undefined && Number(e.priceUsd) > maxPriceUsd)) continue;
            out.push({ id: e.id, url: e.url, seller: s.id, sellerName: s.name, kind: e.kind, description: e.description, capabilities: e.capabilities, priceUsd: e.priceUsd, priceUsdc: e.priceUsdc, sessions: !!e.sessions, simulated: doc.simulated, directory: dir });
          }
        }
      } catch {
        // An unreachable directory just contributes nothing.
      }
    }
    return out.sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd));
  }

  /** Asks the seller's Penstock instance to rank this buyer's holdings for an endpoint. */
  async routes(endpointUrl: string): Promise<RankedRoute[]> {
    const u = new URL(endpointUrl);
    const m = /^\/p\/([a-z0-9-]+)\/([a-z0-9-]+)/.exec(u.pathname);
    if (!m) throw new Error("not a Penstock endpoint URL");
    const from = this.o.holdings.map((h) => `${h.chain}:${h.symbol}${h.balance ? `:${h.balance}` : ""}`).join(",");
    const r = await this.f(`${u.origin}/api/public/routes?endpoint=${m[1]}.${m[2]}&from=${encodeURIComponent(from)}`);
    if (!r.ok) throw new Error(`routes: HTTP ${r.status}`);
    return ((await r.json()) as { routes: RankedRoute[] }).routes;
  }

  private canPay(route: RankedRoute): boolean {
    if (route.error || route.affordable === false) return false;
    if (route.method === "exact-near") return !!this.o.near;
    return !!this.o.origins?.some((w) => w.chain === route.chain);
  }

  /** Calls a URL; on 402 pays from the cheapest usable holding and retries. */
  async call(url: string, init: RequestInit = {}, maxUsd?: number): Promise<PaidResult> {
    const first = await this.f(url, init);
    if (first.status !== 402) return { status: first.status, body: await readBody(first), paid: false };
    const header = first.headers.get("payment-required");
    if (!header) return { status: 402, body: await readBody(first), paid: false, note: "402 without PAYMENT-REQUIRED" };
    const required = decodePaymentRequiredHeader(header) as PaymentRequired;

    let ranked: RankedRoute[];
    try {
      ranked = await this.routes(url);
    } catch {
      ranked = [];
    }
    const route = ranked.find((r) => this.canPay(r));
    if (!route) return { status: 402, body: required, paid: false, note: "no holding can pay this endpoint" };
    if (maxUsd !== undefined && route.amountInUsd > maxUsd) {
      return { status: 402, body: required, paid: false, note: `cheapest route costs $${route.amountInUsd.toFixed(4)}, above maxUsd $${maxUsd}` };
    }

    if (route.method === "exact-near") {
      const offer = required.accepts.find(isExactNear);
      if (!offer) return { status: 402, body: required, paid: false, note: "seller does not offer exact NEAR" };
      const payload = await buildExactPayload(this.o.near!, required, offer);
      const res = await this.f(url, withPayment(init, payload));
      return this.finish(res, { method: "exact-near", originChain: "near", originSymbol: "USDC", amountIn: offer.amount });
    }

    const chain = chainByKey(route.chain)!;
    const asset = assetOn(chain, route.symbol)!;
    const unquoted = required.accepts.find((a) => isUnquoted(a) && a.network === chain.caip2 && a.asset.toLowerCase() === asset.x402Asset.toLowerCase());
    if (!unquoted) return { status: 402, body: required, paid: false, note: `seller does not accept ${route.symbol} on ${chain.label}` };
    const wallet = this.o.origins!.find((w) => w.chain === route.chain)!;
    const qres = await this.f(url, withPayment(init, buildQuotePayload(required, unquoted, wallet.address)));
    const second = (await qres.json().catch(() => null)) as PaymentRequired | null;
    const quoted = second && findQuotedEntry(second, unquoted);
    if (!quoted) return { status: qres.status, body: second, paid: false, note: "seller did not return a quote" };
    if (maxUsd !== undefined && route.amountInUsd > maxUsd) return { status: 402, body: second, paid: false, note: "quote above maxUsd" };
    const instructions = depositInstructions(quoted);

    let txHash: string;
    try {
      txHash = await wallet.deposit(instructions);
    } catch {
      const resumeId = `res_${Math.random().toString(36).slice(2, 12)}`;
      this.pending.set(resumeId, { url, init, required, unquoted, instructions });
      return { status: 402, body: second, paid: false, depositRequired: { resumeId, instructions }, note: `send ${instructions.amount} base units to ${instructions.payTo} on ${chain.label} before ${instructions.refundDeadline}, then resume with the tx hash` };
    }
    return this.submitDeposit(url, init, required, unquoted, instructions, txHash, { method: "near-intents", originChain: chain.key, originSymbol: asset.symbol, amountIn: instructions.amount });
  }

  /** Completes a payment after the agent made the deposit itself (live mode). */
  async resume(resumeId: string, txHash: string): Promise<PaidResult> {
    const p = this.pending.get(resumeId);
    if (!p) throw new Error("unknown resumeId");
    const chain = CHAINS.find((c) => c.caip2 === p.unquoted.network)!;
    const result = await this.submitDeposit(p.url, p.init, p.required, p.unquoted, p.instructions, txHash, { method: "near-intents", originChain: chain.key, amountIn: p.instructions.amount });
    if (result.paid || result.settlement?.errorReason !== "settlement_pending") this.pending.delete(resumeId);
    return result;
  }

  private async submitDeposit(url: string, init: RequestInit, required: PaymentRequired, unquoted: PaymentRequirements, d: DepositInstructions, txHash: string, meta: Partial<PaidResult>): Promise<PaidResult> {
    const payload = buildDepositPayload(required, unquoted, d, txHash);
    let res = await this.f(url, withPayment(init, payload));
    for (let i = 0; i < (this.o.pendingRetries ?? 6) && res.status === 402; i++) {
      const s = res.headers.get("payment-response");
      const settle = s ? (decodePaymentResponseHeader(s) as SettleResponse) : null;
      if (settle?.errorReason !== "settlement_pending") break;
      await sleep(Number(res.headers.get("retry-after") ?? 3) * 1000);
      res = await this.f(url, withPayment(init, payload)); // same operationToken, as the draft requires
    }
    return this.finish(res, meta);
  }

  private async finish(res: Response, meta: Partial<PaidResult>): Promise<PaidResult> {
    const s = res.headers.get("payment-response");
    const r = res.headers.get("penstock-receipt");
    return {
      status: res.status, body: await readBody(res), paid: res.ok, ...meta,
      ...(s ? { settlement: decodePaymentResponseHeader(s) as SettleResponse } : {}),
      ...(r ? { receipt: JSON.parse(Buffer.from(r, "base64url").toString("utf8")) } : {}),
    };
  }
}

function withPayment(init: RequestInit, payload: PaymentPayload): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } };
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 4000);
  }
}

export function describeUsd(baseUnits: string): string {
  return `$${formatUnits(baseUnits, 6)}`;
}
