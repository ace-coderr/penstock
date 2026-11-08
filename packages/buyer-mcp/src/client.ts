import { createHash } from "node:crypto";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { assetOn, chainByKey, formatUnits, type PaymentPayload, type PaymentRequired, type PaymentRequirements, type SettleResponse } from "@penstock/core";
import {
  buildDepositPayload, buildQuotePayload, depositInstructions, findQuotedEntry, isUnquoted, type DepositInstructions, type Holding, type RankedRoute,
} from "@penstock/intents-adapter";
import { envelopeFor, plainEnvelope, type Envelope } from "./envelope";
import { buildExactPayload, isExactNear } from "./exact";
import { Journal, TERMINAL_STATES, hashParams, movedMoney, operationKey, type Operation, type OperationRequest, type RefundState } from "./journal";
import type { NearWallet } from "./near-wallet";

/**
 * A buyer for Penstock-protected endpoints. It finds sellers through `/.well-known/penstock.json`,
 * answers 402s on its own, and pays from whichever of its holdings is cheapest: USDC on NEAR
 * directly, or any other chain and token through NEAR Intents.
 *
 * Every payment is an operation in a write-ahead journal (journal.ts). Calling again after an
 * error never opens a second deposit: it returns, and where possible completes, the first one.
 */

export interface OriginWallet {
  chain: string;
  address: string;
  simulated: boolean;
  /**
   * Sends `amount` of `asset` to `payTo` on this chain and returns the transaction hash. Throw
   * `ManualDepositRequired` when this wallet cannot send and the agent must do it; any other error
   * is treated as "may have been sent".
   */
  deposit(d: DepositInstructions): Promise<string>;
}

/** Thrown by a wallet that sent nothing and cannot: the agent must make the deposit itself. */
export class ManualDepositRequired extends Error {}

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

export interface PaidResult extends Partial<Envelope> {
  status: number;
  body: unknown;
  paid: boolean;
  method?: "exact-near" | "near-intents" | "session";
  originChain?: string;
  originSymbol?: string;
  amountIn?: string;
  settlement?: SettleResponse;
  receipt?: unknown;
  /** Set when a live deposit is needed and no origin wallet can make it. resumeId is the operation id. */
  depositRequired?: { resumeId: string; instructions: DepositInstructions };
  /** True when this answer comes from an earlier operation on file (with its original receipt): no new payment was made by this call. */
  replayed?: boolean;
  note?: string;
}

export type SealedResult = PaidResult & Envelope;

export interface BuyerOptions {
  directories: string[];
  holdings: Holding[];
  near?: NearWallet;
  origins?: OriginWallet[];
  fetchImpl?: typeof fetch;
  /** settlement_pending retries with the same payload. */
  pendingRetries?: number;
  /** Sent as User-Agent so a seller can tell agents apart. */
  userAgent?: string;
  /** The operation journal; default is in memory. buyerFromEnv uses a file so it survives restarts. */
  journal?: Journal;
  /** Stable identity for journal keys; default is derived from the wallets. */
  buyerId?: string;
  /** How long an identical call replays an unacknowledged delivered result instead of buying again. Default 10 minutes. */
  replayWindowMs?: number;
  /** Refuse to open a new purchase once the journal's paid total (USDC base units) would pass this. */
  maxTotalUsdc?: bigint;
  /**
   * No agent in the loop (agent-to-agent resale): a terminal operation never needs a status check
   * or an explicit new_purchase before the next purchase. Non-terminal operations still block.
   */
  autonomous?: boolean;
}

export interface CallOptions {
  /** Buy again even though the previous operation for this call is resolved with money moved (needs penstock_status first). */
  newPurchase?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BODY_KEEP = 256 * 1024;
const BODY_TTL_MS = 24 * 3_600_000;

interface Parsed {
  res: Response;
  settle: SettleResponse | null;
  receipt: unknown | null;
  body: unknown;
}

export class PenstockBuyer {
  private readonly f: typeof fetch;
  readonly journal: Journal;
  private readonly buyerId: string;
  private readonly inflight = new Map<string, Promise<SealedResult>>();

  constructor(private readonly o: BuyerOptions) {
    const base = o.fetchImpl ?? fetch;
    this.f = o.userAgent
      ? (((input: string | URL | Request, init: RequestInit = {}) => base(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "user-agent": o.userAgent! } })) as typeof fetch)
      : base;
    this.journal = o.journal ?? new Journal();
    this.buyerId = o.buyerId ?? createHash("sha256").update([o.near?.accountId ?? "", ...(o.origins ?? []).map((w) => `${w.chain}:${w.address}`)].join("|")).digest("hex").slice(0, 16);
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

  /** Open sessions this buyer funded, keyed by endpoint URL (without query). */
  private readonly sessions = new Map<string, { token: string; closeUrl: string; opId?: string }>();

  private total(): bigint {
    return this.journal.paidTotal();
  }

  private seal(r: PaidResult, op?: Operation | null, nextAction?: string): SealedResult {
    if (op) {
      // Only a delivered result's body goes back to the agent as data. For every other state the seller's
      // words are kept as a quoted message, so a stale instruction in them ("retry...") cannot drive the agent.
      const body = op.state === "delivered" || r.method === "session" ? r.body : { seller_message: sellerMessage(r.body) };
      return { ...r, body, ...envelopeFor(op, this.total()) };
    }
    const e = plainEnvelope(this.total(), nextAction ?? (r.paid ? "Done." : "Nothing was bought: no payment was started, so no deposit was sent."));
    return { ...r, ...e };
  }

  // ── the public call ────────────────────────────────────────────────────

  /**
   * Calls a URL; on 402 pays from the cheapest usable holding and retries. When the price is below
   * every holding's route minimum (1Click bridge minimums), it funds a prepaid session once and
   * meters later calls against it. Calling again after an error returns the first operation's state
   * (and finishes it if it can) instead of paying twice.
   */
  async call(url: string, init: RequestInit = {}, maxUsd?: number, opts: CallOptions = {}): Promise<SealedResult> {
    const method = (init.method ?? "GET").toUpperCase();
    const ckey = operationKey(this.buyerId, method, url, hashParams(method, typeof init.body === "string" ? init.body : null));
    const running = this.inflight.get(ckey);
    if (running) {
      const joined = await running;
      return { ...joined, note: `${joined.note ? `${joined.note}; ` : ""}joined an identical call that was already in progress` };
    }
    const p = this.callInner(url, init, maxUsd, opts).finally(() => this.inflight.delete(ckey));
    this.inflight.set(ckey, p);
    return p;
  }

  private async callInner(url: string, init: RequestInit, maxUsd: number | undefined, opts: CallOptions): Promise<SealedResult> {
    const key = url.split("?")[0]!;
    const cached = this.sessions.get(key) ?? this.rehydrateSession(key);
    if (cached) {
      const r = await this.f(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "PENSTOCK-SESSION": cached.token } });
      if (r.status !== 402 && r.status !== 410 && r.status !== 401) {
        const fin = await this.finish(r, { method: "session", note: r.headers.get("penstock-session-balance") ?? undefined });
        return this.seal(fin, null, "Metered against your prepaid session: this call moved no new money.");
      }
      this.sessions.delete(key);
    }
    const first = await this.f(url, init);
    if (first.status !== 402) {
      const fin: PaidResult = { status: first.status, body: await readBody(first), paid: false };
      return this.seal(fin, null, first.ok ? "This endpoint answered without asking for payment." : "No payment was asked for or sent.");
    }
    const header = first.headers.get("payment-required");
    if (!header) return this.seal({ status: 402, body: await readBody(first), paid: false, note: "402 without PAYMENT-REQUIRED" });
    const required = decodePaymentRequiredHeader(header) as PaymentRequired;

    let ranked: RankedRoute[];
    try {
      ranked = await this.routes(url);
    } catch {
      ranked = [];
    }
    const price = BigInt(required.accepts.find(isExactNear)?.amount ?? "0");
    if (maxUsd !== undefined && Number(price) / 1e6 > maxUsd) {
      return this.seal({ status: 402, body: required, paid: false, note: `price ${Number(price) / 1e6} is above maxUsd ${maxUsd}. maxUsd covers the price plus the route fee, so raise it above the price` });
    }
    const route = ranked.find((r) => this.canPay(r));
    if (route) {
      if (maxUsd !== undefined && route.amountInUsd > maxUsd) {
        const total = route.amountInUsd.toFixed(4);
        return this.seal({ status: 402, body: required, paid: false, note: `this route costs ${total} in total (price ${(Number(price) / 1e6).toFixed(4)} + route fee ${route.feeUsd.toFixed(4)}); raise maxUsd to at least ${total}. maxUsd covers price plus route fee. Nothing was paid` });
      }
      return this.pay(url, init, required, route, opts);
    }
    return this.viaSession(url, init, price, ranked, opts);
  }

  private hasWallet(r: RankedRoute): boolean {
    return r.method === "exact-near" ? !!this.o.near : !!this.o.origins?.some((w) => w.chain === r.chain);
  }

  private async viaSession(url: string, init: RequestInit, price: bigint, ranked: RankedRoute[], opts: CallOptions): Promise<SealedResult> {
    const CAP = 5_000_000n;
    const candidate = ranked
      .filter((r) => r.minAmountOut && this.hasWallet(r) && BigInt(r.minAmountOut) <= CAP)
      .sort((a, b) => Number(BigInt(a.minAmountOut!) - BigInt(b.minAmountOut!)))[0];
    if (!candidate) {
      const mins = ranked.filter((r) => r.minAmountOut).map((r) => `${r.symbol}@${r.chain} needs at least $${Number(r.minAmountOut) / 1e6}`).join(", ");
      return this.seal({ status: 402, body: null, paid: false, note: mins ? `no holding can pay this endpoint (${mins})` : "no holding can pay this endpoint" });
    }
    const u = new URL(url);
    const m = /^\/p\/([a-z0-9-]+)\/([a-z0-9-]+)/.exec(u.pathname)!;
    // Fund the route minimum (+5% headroom) or 25 calls, whichever is larger, within the cap.
    let fund = (BigInt(candidate.minAmountOut!) * 105n) / 100n;
    if (price * 25n > fund) fund = price * 25n;
    if (fund > CAP) fund = CAP;
    fund = ((fund + 999n) / 1000n) * 1000n;
    const openUrl = `${u.origin}/s/${m[1]}/${m[2]}/open/${fund}`;
    const first = await this.f(openUrl);
    if (first.status !== 402) return this.seal({ status: first.status, body: await readBody(first), paid: false, note: "price is below the route minimum and this endpoint does not offer sessions" });
    const required = decodePaymentRequiredHeader(first.headers.get("payment-required")!) as PaymentRequired;
    const opened = await this.pay(openUrl, {}, required, candidate, opts);
    const token = (opened.body as { session?: { token?: string } } | null)?.session?.token;
    if (!opened.paid || !token) return { ...opened, note: `could not open a session: ${opened.note ?? opened.status}` };
    this.sessions.set(url.split("?")[0]!, { token, closeUrl: `${u.origin}/s/${m[1]}/${m[2]}/close`, opId: opened.operation_id ?? undefined });
    const r = await this.f(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "PENSTOCK-SESSION": token } });
    const fin = await this.finish(r, {
      method: "session", originChain: opened.originChain, originSymbol: opened.originSymbol, amountIn: opened.amountIn, receipt: opened.receipt, settlement: opened.settlement,
      note: `opened a $${Number(fund) / 1e6} session via ${opened.method} from ${opened.originSymbol} on ${opened.originChain} (price below the route minimum)`,
    });
    const op = opened.operation_id ? this.journal.get(opened.operation_id) : undefined;
    return op ? this.seal(fin, op) : this.seal(fin, null, "Session opened.");
  }

  /** After a restart: reuse a session this journal remembers opening (the seller still checks the token). */
  private rehydrateSession(key: string): { token: string; closeUrl: string; opId?: string } | undefined {
    const u = new URL(key);
    const m = /^\/p\/([a-z0-9-]+)\/([a-z0-9-]+)/.exec(u.pathname);
    if (!m) return undefined;
    const prefix = `${u.origin}/s/${m[1]}/${m[2]}/open/`;
    const ops = this.journal.all().filter((op) => op.url.startsWith(prefix) && op.state === "delivered" && !op.note?.includes("session closed"));
    const op = ops[ops.length - 1];
    const token = (op?.resultBody as { session?: { token?: string } } | null)?.session?.token;
    if (!op || !token) return undefined;
    const s = { token, closeUrl: `${u.origin}/s/${m[1]}/${m[2]}/close`, opId: op.id };
    this.sessions.set(key, s);
    return s;
  }

  /** Closes every session this buyer opened; unused balances are refunded by the seller. */
  async closeSessions(): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const [k, s] of this.sessions) {
      const r = await this.f(s.closeUrl, { method: "POST", headers: { "PENSTOCK-SESSION": s.token } });
      out.push(await readBody(r));
      this.sessions.delete(k);
      if (s.opId) this.journal.update(s.opId, { note: "session closed" });
    }
    return out;
  }

  // ── paying: one operation per pay() ───────────────────────────────────

  private async pay(url: string, init: RequestInit, required: PaymentRequired, route: RankedRoute, opts: CallOptions): Promise<SealedResult> {
    const method = (init.method ?? "GET").toUpperCase() as "GET" | "POST";
    const body = typeof init.body === "string" ? init.body : null;
    const paramsHash = hashParams(method, body);
    const key = operationKey(this.buyerId, method, url, paramsHash);
    const request: OperationRequest = { method, headers: pickHeaders(init), body };
    const amountUsdc = required.accepts.find(isExactNear)?.amount ?? (required.accepts.map((a) => (a.extra?.destination as { amount?: string } | undefined)?.amount).find(Boolean) ?? "0");

    // Claim under the lock: look at what this key already did, then write the intent, in one step.
    const claim = this.journal.withLock((): { kind: "return"; op: Operation } | { kind: "refuse"; message: string } | { kind: "go"; op: Operation } => {
      if (this.journal.tampered) return { kind: "refuse", message: `the operation journal failed its integrity check (line ${this.journal.tampered.line}), so this buyer cannot tell what it already paid. It refuses new purchases; the money state is unknown. Do not retry` };
      const latest = this.journal.latest(key);
      const verdict = verdictFor(latest, opts, this.o.autonomous === true, Date.now(), this.o.replayWindowMs ?? 600_000);
      if (verdict === "return") return { kind: "return", op: latest! };
      if (verdict === "continue") return { kind: "go", op: latest! };
      if (verdict === "expire") this.journal.update(latest!.id, { state: "expired" });
      if (this.o.maxTotalUsdc !== undefined && this.journal.paidTotal() + BigInt(amountUsdc) > this.o.maxTotalUsdc) {
        return { kind: "refuse", message: `this purchase would take the total paid past the configured limit of ${formatUnits(this.o.maxTotalUsdc, 6)} USDC` };
      }
      return {
        kind: "go",
        op: this.journal.insert({
          key, buyer: this.buyerId, method: route.method === "exact-near" ? "exact-near" : "near-intents", url, paramsHash, request, state: "quoted", amountUsdc, feeUsdc: toMicro(route.feeUsd), debitedUsdc: route.method === "exact-near" ? amountUsdc : toMicro(route.amountInUsd), debited: { amount: route.amountIn, symbol: route.symbol }, paymentId: null,
          originChain: route.chain, originSymbol: route.symbol, quote: null, exactPayload: null, txHash: null, manualDeposit: false, receipt: null, settlement: null,
          resultBody: null, resultStatus: null, acknowledged: false, statusViewed: false, refundState: "none", refundAmountUsdc: null, lastError: null, note: null,
        }),
      };
    });

    if (claim.kind === "refuse") return this.seal({ status: 402, body: null, paid: false, note: claim.message });
    if (claim.kind === "return") return this.returnExisting(claim.op);

    let op = claim.op;
    try {
      if (route.method === "exact-near") return await this.payExact(op, init, required);
      return await this.payIntents(op, init, required, route);
    } catch (e) {
      // An unexpected error after the write-ahead: whatever the journal says is the truth; never "nothing was paid".
      op = this.journal.get(op.id) ?? op;
      if (!TERMINAL_STATES.has(op.state) && op.state !== "quoted") op = this.journal.update(op.id, { lastError: (e as Error).message });
      else if (op.state === "quoted") op = this.journal.update(op.id, { state: "failed", lastError: (e as Error).message });
      return this.seal({ status: 502, body: null, paid: false, note: `internal error: ${(e as Error).message}` }, op);
    }
  }

  private async payExact(op: Operation, init: RequestInit, required: PaymentRequired): Promise<SealedResult> {
    const offer = required.accepts.find(isExactNear);
    if (!offer) {
      const failed = this.journal.update(op.id, { state: "failed", lastError: "the seller does not offer exact NEAR" });
      return this.seal({ status: 402, body: required, paid: false, note: "seller does not offer exact NEAR" }, failed);
    }
    const payload = await buildExactPayload(this.o.near!, required, offer);
    const header = encodePaymentSignatureHeader(payload);
    // Write-ahead: the signed payment is recorded before it is presented.
    this.journal.update(op.id, { state: "deposit_sent_unconfirmed", exactPayload: header, quote: null });
    let res: Response;
    try {
      res = await this.f(op.url, withPayment(init, payload));
    } catch (e) {
      const cur = this.journal.update(op.id, { lastError: (e as Error).message });
      return this.seal({ status: 502, body: null, paid: false, note: `no answer from the seller after the payment was presented: ${(e as Error).message}` }, cur);
    }
    const parsed = await parse(res);
    const done = this.applyResponse(op.id, parsed);
    return this.finishOp(done, parsed, { method: "exact-near", originChain: "near", originSymbol: "USDC", amountIn: offer.amount });
  }

  private async payIntents(op0: Operation, init: RequestInit, required: PaymentRequired, route: RankedRoute): Promise<SealedResult> {
    const url = op0.url;
    const chain = chainByKey(route.chain)!;
    const asset = assetOn(chain, route.symbol)!;
    const unquoted = required.accepts.find((a) => isUnquoted(a) && a.network === chain.caip2 && a.asset.toLowerCase() === asset.x402Asset.toLowerCase());
    if (!unquoted) {
      const failed = this.journal.update(op0.id, { state: "failed", lastError: `seller does not accept ${route.symbol} on ${chain.label}` });
      return this.seal({ status: 402, body: required, paid: false, note: `seller does not accept ${route.symbol} on ${chain.label}` }, failed);
    }
    const wallet = this.o.origins!.find((w) => w.chain === route.chain)!;
    // The quote is idempotent on the seller side: asking again returns the same deposit address.
    const qres = await this.f(url, withPayment(init, buildQuotePayload(required, unquoted, wallet.address)));
    const second = (await qres.json().catch(() => null)) as PaymentRequired | null;
    const quoted = second && findQuotedEntry(second, unquoted);
    if (!quoted) {
      const failed = this.journal.update(op0.id, { state: "failed", lastError: second?.error ?? "the seller did not return a quote" });
      return this.seal({ status: qres.status, body: second, paid: false, note: second?.error ?? "seller did not return a quote" }, failed);
    }
    const instructions = depositInstructions(quoted);
    let op = this.journal.update(op0.id, {
      quote: { resourceUrl: required.resource.url, unquoted, payTo: instructions.payTo, amount: instructions.amount, depositMemo: instructions.depositMemo, refundDeadline: instructions.refundDeadline, operationToken: instructions.operationToken, refundTo: wallet.address },
    });

    // Write-ahead: the deposit is recorded as started BEFORE the wallet is asked to send it. If the
    // process dies in between, the journal says "may have been sent" and nothing will pay again.
    op = this.journal.update(op.id, { state: "deposit_sent_unconfirmed" });
    let txHash: string;
    try {
      txHash = await wallet.deposit(instructions);
    } catch (e) {
      if (e instanceof ManualDepositRequired) {
        op = this.journal.update(op.id, { state: "quoted", manualDeposit: true, lastError: null });
        return this.seal({
          status: 402, body: second, paid: false, depositRequired: { resumeId: op.id, instructions },
          note: `send ${instructions.amount} base units to ${instructions.payTo} on ${chain.label} before ${instructions.refundDeadline}, then call penstock_resume with the tx hash`,
        }, op);
      }
      op = this.journal.update(op.id, { lastError: (e as Error).message });
      return this.seal({ status: 502, body: null, paid: false, note: "the deposit may or may not have been sent" }, op);
    }
    op = this.journal.update(op.id, { state: "confirming", txHash });
    return this.submit(op, {}, { method: "near-intents", originChain: chain.key, originSymbol: asset.symbol, amountIn: instructions.amount });
  }

  /** Completes a payment after the agent made the deposit itself (live mode). `resumeId` is the operation id. */
  async resume(resumeId: string, txHash: string): Promise<SealedResult> {
    const op = this.journal.get(resumeId);
    if (!op) throw new Error("unknown operation id");
    if (op.method !== "near-intents" || !op.quote) throw new Error("this operation has no deposit to resume");
    if (op.txHash && op.txHash !== txHash) throw new Error(`this operation already has deposit ${op.txHash}; it will not take a second one`);
    if (op.state === "quoted" && new Date(op.quote.refundDeadline).getTime() < Date.now()) throw new Error("the quote expired before a deposit was reported; start a new purchase");
    if (!["quoted", "deposit_sent_unconfirmed", "confirming"].includes(op.state)) return this.returnExisting(op);
    const cur = this.journal.update(op.id, { state: "confirming", txHash, manualDeposit: false });
    return this.submit(cur, {}, { method: "near-intents", originChain: cur.originChain ?? undefined, originSymbol: cur.originSymbol ?? undefined, amountIn: cur.quote!.amount });
  }

  /** Presents the stored deposit payload (same operation token) and records what the seller said. */
  private async submit(op: Operation, init: RequestInit, meta: Partial<PaidResult>, retries = this.o.pendingRetries ?? 6): Promise<SealedResult> {
    const q = op.quote!;
    const instructions: DepositInstructions = { network: (q.unquoted as PaymentRequirements).network, asset: (q.unquoted as PaymentRequirements).asset, amount: q.amount, payTo: q.payTo, ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}), refundDeadline: q.refundDeadline, operationToken: q.operationToken };
    const stub: PaymentRequired = { x402Version: 2, resource: { url: q.resourceUrl }, accepts: [] };
    const payload = buildDepositPayload(stub, q.unquoted as PaymentRequirements, instructions, op.txHash!);
    const reqInit = { ...fromRequest(op.request), ...init, headers: { ...fromRequest(op.request).headers, ...(init.headers as Record<string, string> | undefined) } };
    let parsed: Parsed;
    try {
      let res = await this.f(op.url, withPayment(reqInit, payload));
      for (let i = 0; i < retries && res.status === 402; i++) {
        const s = res.headers.get("payment-response");
        const settle = s ? (decodePaymentResponseHeader(s) as SettleResponse) : null;
        if (settle?.errorReason !== "settlement_pending") break;
        await sleep(Number(res.headers.get("retry-after") ?? 3) * 1000);
        res = await this.f(op.url, withPayment(reqInit, payload)); // same operationToken, as the draft requires
      }
      parsed = await parse(res);
    } catch (e) {
      const cur = this.journal.update(op.id, { lastError: (e as Error).message });
      return this.seal({ status: 502, body: null, paid: false, ...meta, note: "the deposit was sent; the seller did not answer yet" }, cur);
    }
    const done = this.applyResponse(op.id, parsed);
    return this.finishOp(done, parsed, meta);
  }

  /** Maps one seller response onto the operation's state. */
  private applyResponse(opId: string, p: Parsed): Operation {
    const cur = this.journal.get(opId)!;
    const status = p.res.status;
    const settle = p.settle;
    const keep = p.body === undefined ? null : truncate(p.body);
    const paymentId = (p.receipt as { body?: { paymentId?: string } } | null)?.body?.paymentId ?? cur.paymentId;
    const base: Partial<Operation> = { resultStatus: status, settlement: settle, receipt: p.receipt, paymentId, lastError: null };
    if (settle?.success && p.receipt) {
      if (status >= 500 || (status === 200 && isEmpty(p.body))) {
        return this.journal.update(opId, { ...base, state: "upstream_failed_after_settlement", resultBody: keep, refundState: refundStateFrom(p.body) });
      }
      return this.journal.update(opId, { ...base, state: "delivered", resultBody: keep });
    }
    if (status === 402) {
      const reason = settle?.errorReason;
      const oneClick = String((settle?.extra as { status?: string } | undefined)?.status ?? "");
      if (reason === "settlement_pending") return this.journal.update(opId, { ...base, state: "confirming", resultBody: keep });
      if (reason === "exact_near_intents_payment_failed" || reason === "exact_near_intents_insufficient_deposit") {
        if (oneClick === "REFUNDED") return this.journal.update(opId, { ...base, state: "refunded", refundState: "refunded", resultBody: keep });
        return this.journal.update(opId, { ...base, state: "failed", refundState: "in_progress", resultBody: keep, lastError: `1Click reports ${oneClick || "a failed swap"}` });
      }
      // Anything else after a deposit (the seller's "try again", an already-redeemed note, a rate limit): the deposit stands.
      if (cur.txHash || cur.exactPayload) return this.journal.update(opId, { ...base, state: cur.exactPayload && !cur.txHash ? "deposit_sent_unconfirmed" : "confirming", resultBody: keep, lastError: errorText(p.body) });
      return this.journal.update(opId, { ...base, state: "failed", resultBody: keep, lastError: errorText(p.body) });
    }
    if (cur.txHash || cur.exactPayload) return this.journal.update(opId, { ...base, state: cur.exactPayload && !cur.txHash ? "deposit_sent_unconfirmed" : "confirming", resultBody: keep, lastError: errorText(p.body) });
    return this.journal.update(opId, { ...base, state: "failed", resultBody: keep, lastError: errorText(p.body) });
  }

  private finishOp(op: Operation, p: Parsed, meta: Partial<PaidResult>): SealedResult {
    const cur = op;
    return this.seal({
      status: p.res.status, body: p.body, paid: p.res.ok, ...meta,
      ...(p.settle ? { settlement: p.settle } : {}), ...(p.receipt ? { receipt: p.receipt } : {}),
    }, cur);
  }

  // ── a call that finds an operation already on file ─────────────────────

  /** Returns what an earlier operation for this call did, completing it first if it can be completed. */
  private async returnExisting(op0: Operation): Promise<SealedResult> {
    const op = await this.reconcile(op0);
    const deliveredUnacked = op.state === "delivered" && !op.acknowledged;
    const failedMoved = op.state === "upstream_failed_after_settlement" || (op.state === "failed" && movedMoney(op) !== "no");
    const result: PaidResult = {
      replayed: true, status: op.resultStatus ?? 402, body: op.state === "delivered" || failedMoved ? op.resultBody : null, paid: op.state === "delivered" && (op.resultStatus ?? 0) < 400,
      method: op.method, originChain: op.originChain ?? undefined, originSymbol: op.originSymbol ?? undefined,
      ...(op.settlement ? { settlement: op.settlement as SettleResponse } : {}), ...(op.receipt ? { receipt: op.receipt } : {}),
      note: deliveredUnacked
        ? "this is the result of the earlier payment, kept in the journal; no new payment was made"
        : "this call already has an operation on file; no new quote or deposit was opened",
      ...(op.manualDeposit && op.quote ? { depositRequired: { resumeId: op.id, instructions: instructionsOf(op) } } : {}),
    };
    return this.seal(result, op);
  }

  /** Asks the seller what happened to this operation and moves the journal to match. Never sends money. */
  async reconcile(op0: Operation): Promise<Operation> {
    let op = op0;
    const now = Date.now();
    if (op.state === "quoted" && op.quote && !op.manualDeposit && new Date(op.quote.refundDeadline).getTime() < now) return this.journal.update(op.id, { state: "expired" });
    if (op.method === "exact-near" && op.exactPayload && op.state === "deposit_sent_unconfirmed") return this.resendExact(op);
    if (!op.quote?.operationToken || TERMINAL_STATES.has(op.state) && op.state !== "upstream_failed_after_settlement" && !(op.state === "failed" && op.refundState === "in_progress")) return op;
    const view = await this.lookup(op);
    if (!view) {
      // The seller offers no lookup (or is unreachable): presenting the same deposit payload again is safe and idempotent.
      if (op.txHash && (op.state === "confirming" || op.state === "deposit_sent_unconfirmed")) {
        await this.submit(op, {}, { method: "near-intents" }, 1);
        return this.journal.get(op.id)!;
      }
      return op;
    }
    switch (view.state) {
      case "deposit_in_progress":
      case "settled_not_delivered":
        // The seller has the deposit (or settled it) but has not delivered: presenting the same payload again completes it.
        if (op.txHash && (op.state === "confirming" || op.state === "deposit_sent_unconfirmed")) {
          const meta = { method: "near-intents" as const, originChain: op.originChain ?? undefined, originSymbol: op.originSymbol ?? undefined, amountIn: op.quote.amount };
          await this.submit(op, {}, meta, 1);
          op = this.journal.get(op.id)!;
        }
        break;
      case "delivered":
        if (op.state !== "delivered") {
          op = this.journal.update(op.id, { state: "delivered", paymentId: view.payment_id ?? op.paymentId, receipt: view.receipt ?? op.receipt, resultBody: op.resultBody ?? null, note: "the seller delivered; this buyer did not receive the response body, so it is not available here" });
        }
        break;
      case "upstream_failed":
      case "delivery_unknown":
        op = this.journal.update(op.id, { state: "upstream_failed_after_settlement", paymentId: view.payment_id ?? op.paymentId, receipt: view.receipt ?? op.receipt, refundState: view.refund_state ?? op.refundState, refundAmountUsdc: view.refund_amount_usdc ?? op.refundAmountUsdc });
        break;
      case "refunded":
        op = this.journal.update(op.id, { state: op.state === "upstream_failed_after_settlement" ? op.state : "refunded", refundState: "refunded", refundAmountUsdc: view.refund_amount_usdc ?? op.refundAmountUsdc });
        break;
      case "refund_in_progress":
        op = this.journal.update(op.id, { state: "failed", refundState: "in_progress" });
        break;
      case "expired":
        if (!op.txHash && !op.exactPayload) op = this.journal.update(op.id, { state: "expired" });
        break;
      default:
        break;
    }
    if (op.state === "upstream_failed_after_settlement" && view.refund_state && view.refund_state !== op.refundState) {
      op = this.journal.update(op.id, { refundState: view.refund_state, refundAmountUsdc: view.refund_amount_usdc ?? op.refundAmountUsdc });
    }
    return op;
  }

  /** Presents the stored signed exact payment once more; the seller and facilitator treat a repeat as the same payment. */
  private async resendExact(op: Operation): Promise<Operation> {
    try {
      const res = await this.f(op.url, { ...fromRequest(op.request), headers: { ...op.request.headers, "PAYMENT-SIGNATURE": op.exactPayload! } });
      return this.applyResponse(op.id, await parse(res));
    } catch {
      return op;
    }
  }

  private async lookup(op: Operation): Promise<SellerOperationView | null> {
    try {
      const origin = new URL(op.url).origin;
      const r = await this.f(`${origin}/api/public/operation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationToken: op.quote!.operationToken }) });
      if (!r.ok) return null;
      return ((await r.json()) as { operation: SellerOperationView }).operation;
    } catch {
      return null;
    }
  }

  // ── status ─────────────────────────────────────────────────────────────

  /** What happened to an operation, confirmed with the seller where possible. `idOrLast`: an operation id or "last". */
  async status(idOrLast = "last"): Promise<SealedResult & { operation_summary?: Record<string, unknown> }> {
    const op0 = idOrLast === "last" || !idOrLast ? this.journal.last() : this.journal.get(idOrLast);
    if (!op0) {
      return { ...this.seal({ status: 404, body: null, paid: false }, null, idOrLast === "last" ? "This buyer has not started any payment, so there is nothing to look up." : `No operation ${idOrLast} is in this buyer's journal.`), state: "no_operation" };
    }
    let op = await this.reconcile(op0);
    const moved = movedMoney(op);
    if (moved !== "no" && !op.statusViewed) op = this.journal.update(op.id, { statusViewed: true });
    if (op.state === "delivered" && !op.acknowledged) op = this.journal.update(op.id, { acknowledged: true });
    const e = envelopeFor(op, this.total());
    return {
      status: op.resultStatus ?? 0, body: op.state === "delivered" ? this.storedBody(op) : null, paid: op.state === "delivered", ...e,
      ...(op.receipt ? { receipt: op.receipt } : {}),
      operation_summary: {
        url: op.url, method: op.method, origin: op.originChain, symbol: op.originSymbol, deposit_address: op.quote?.payTo ?? null, deposit_tx: op.txHash,
        quote_deadline: op.quote?.refundDeadline ?? null, created_at: new Date(op.createdAt).toISOString(), updated_at: new Date(op.updatedAt).toISOString(), last_error: op.lastError,
      },
    };
  }

  /** The delivered body kept in the journal: capped at 256 KB when stored, dropped after 24 hours. */
  private storedBody(op: Operation): unknown {
    return Date.now() - op.updatedAt > BODY_TTL_MS ? null : op.resultBody;
  }

  /** Whether the journal can be trusted. When false, new purchases are refused. */
  get journalTampered(): { line: number } | null {
    return this.journal.tampered;
  }

  private async finish(res: Response, meta: Partial<PaidResult>): Promise<PaidResult> {
    const p = await parse(res);
    return {
      status: res.status, body: p.body, paid: res.ok, ...meta,
      ...(p.settle ? { settlement: p.settle } : {}), ...(p.receipt ? { receipt: p.receipt } : {}),
    };
  }
}

// ── the retry rules ──────────────────────────────────────────────────────

/**
 * What a call does when this key already has an operation:
 *   new      open a fresh one
 *   continue the operation has only a quote: carry on with it (the seller returns the same quote)
 *   expire   the quote ran out with no deposit: mark it and open a fresh one
 *   return   give back the earlier operation's state and result; pay nothing
 */
export function verdictFor(latest: Operation | undefined, opts: CallOptions, autonomous: boolean, now: number, replayWindowMs = 600_000): "new" | "continue" | "expire" | "return" {
  if (!latest) return "new";
  switch (latest.state) {
    case "quoted":
      if (latest.quote && !latest.manualDeposit && new Date(latest.quote.refundDeadline).getTime() < now) return "expire";
      return "continue";
    case "deposit_sent_unconfirmed":
    case "confirming":
      return "return"; // never bypassed, not even by new_purchase
    case "delivered":
      // The agent may not have received the result (a lost response is indistinguishable from a retry), so an
      // identical call replays the stored result until the agent acknowledges it (penstock_status), asks for a
      // new purchase, or the replay window passes.
      if (autonomous || latest.acknowledged || opts.newPurchase || now - latest.updatedAt > replayWindowMs) return "new";
      return "return";
    case "refunded":
    case "expired":
      return "new";
    case "upstream_failed_after_settlement":
    case "failed": {
      if (latest.state === "failed" && movedMoney(latest) === "no") return "new";
      if (latest.refundState === "refunded") return "new";
      // Money moved and has not come back: only an explicit new purchase after a status check, or an autonomous buyer.
      if (autonomous) return "new";
      return opts.newPurchase && latest.statusViewed ? "new" : "return";
    }
  }
}

export interface SellerOperationView {
  state: "quoted" | "deposit_in_progress" | "settled_not_delivered" | "delivered" | "upstream_failed" | "delivery_unknown" | "refunded" | "refund_in_progress" | "expired" | "unknown";
  payment_id?: string;
  receipt?: unknown;
  refund_state?: RefundState;
  refund_amount_usdc?: string;
}

/** The seller says in the 502 body when it has booked a refund for a payment whose upstream failed. */
function refundStateFrom(body: unknown): RefundState {
  const r = (body as { refund?: { state?: string } } | null)?.refund;
  return r?.state === "owed" ? "owed" : r?.state === "sent" ? "refunded" : "none";
}

function instructionsOf(op: Operation): DepositInstructions {
  const q = op.quote!;
  return { network: (q.unquoted as PaymentRequirements).network, asset: (q.unquoted as PaymentRequirements).asset, amount: q.amount, payTo: q.payTo, ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}), refundDeadline: q.refundDeadline, operationToken: q.operationToken };
}

function sellerMessage(body: unknown): string | null {
  if (typeof body === "string") return body.slice(0, 300);
  if (body && typeof body === "object") {
    const b = body as { error?: unknown };
    if (typeof b.error === "string") return b.error.slice(0, 300);
  }
  return null;
}

function toMicro(usd: number): string {
  return BigInt(Math.max(0, Math.round(usd * 1e6))).toString();
}

function pickHeaders(init: RequestInit): Record<string, string> {
  const h = (init.headers ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (/^(content-type|accept|penstock-resale-depth)$/i.test(k)) out[k] = v;
  return out;
}

function fromRequest(r: OperationRequest): RequestInit {
  return { method: r.method, headers: r.headers, ...(r.body !== null ? { body: r.body } : {}) };
}

function withPayment(init: RequestInit, payload: PaymentPayload): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } };
}

async function parse(res: Response): Promise<Parsed> {
  const s = res.headers.get("payment-response");
  const r = res.headers.get("penstock-receipt");
  const body = await readBody(res);
  let settle: SettleResponse | null;
  let receipt: unknown | null;
  try {
    settle = s ? (decodePaymentResponseHeader(s) as SettleResponse) : null;
  } catch {
    settle = null;
  }
  try {
    receipt = r ? JSON.parse(Buffer.from(r, "base64url").toString("utf8")) : null;
  } catch {
    receipt = null;
  }
  return { res, settle, receipt, body };
}

function isEmpty(body: unknown): boolean {
  return body === null || body === undefined || body === "" || (typeof body === "object" && Object.keys(body as object).length === 0);
}

function errorText(body: unknown): string | null {
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; note?: unknown };
    if (typeof b.error === "string") return b.error.slice(0, 300);
  }
  return null;
}

function truncate(body: unknown): unknown {
  const text = JSON.stringify(body) ?? "";
  return text.length > BODY_KEEP ? { _truncated: true, bytes: text.length, preview: text.slice(0, 4096) } : body;
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

