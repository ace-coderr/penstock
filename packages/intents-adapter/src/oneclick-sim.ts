import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chainByKey } from "@penstock/core";
import {
  OneClickError, type OneClick, type QuoteRequest, type QuoteResponse, type StatusResponse, type SubmitDepositTxRequest, type SwapStatus, type TokenResponse,
} from "./oneclick";

/**
 * A simulated 1Click backend for demo mode (and for deposits in dry mode). It validates requests
 * like the real API, prices from the recorded token list, and runs the documented status machine.
 * Every deposit address and hash it produces starts with "sim". Nothing here touches a network.
 */

const RECORDED_TOKENS: TokenResponse[] = JSON.parse(readFileSync(new URL("../fixtures/tokens.2026-11-01.json", import.meta.url), "utf8"));

/** The 1Click token list recorded on 2026-11-01 (fixture). */
export function recordedTokens(): TokenResponse[] {
  return RECORDED_TOKENS;
}

const REQUIRED: (keyof QuoteRequest)[] = ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"];

const TIME_ESTIMATE: Record<string, number> = { near: 10, eth: 60, arb: 25, base: 25, op: 25, pol: 30, avax: 25, sol: 20, btc: 900, bsc: 25 };

interface SimQuote {
  response: QuoteResponse;
  deposits: { txHash: string; amount: bigint; at: number }[];
  createdAt: number;
  fail: boolean;
}

export interface SimulatedOneClickOptions {
  /** Whether quote calls count as authenticated (confidential quotes require it, as on the real API). */
  authenticated?: boolean;
  /** How long a detected deposit stays PROCESSING before it resolves. */
  processingMs?: number;
  now?: () => number;
}

function simAddressFor(blockchain: string, seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  if (blockchain === "near") return `sim${h.slice(0, 61)}`;
  if (blockchain === "sol") return `sim${h.slice(0, 40)}`;
  if (blockchain === "btc") return `sim-bc1q${h.slice(0, 34)}`;
  return `sim:0x${h.slice(0, 40)}`;
}

function fmt(v: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / base}${frac ? "." + frac : ""}`;
}

export class SimulatedOneClick implements OneClick {
  readonly kind: "simulated" | "dry" = "simulated";
  private readonly quotes = new Map<string, SimQuote>();
  private readonly opts: Required<SimulatedOneClickOptions>;
  private failNext = false;

  constructor(opts: SimulatedOneClickOptions = {}) {
    this.opts = { authenticated: opts.authenticated ?? false, processingMs: opts.processingMs ?? 1200, now: opts.now ?? Date.now };
  }

  async tokens(): Promise<TokenResponse[]> {
    return RECORDED_TOKENS;
  }

  /** Test hook: the next quote will end in FAILED (refunded to the payer). */
  failNextSwap(): void {
    this.failNext = true;
  }

  private token(assetId: string): TokenResponse {
    const t = RECORDED_TOKENS.find((x) => x.assetId === assetId);
    if (!t) throw new OneClickError(400, `tokenIn is not valid: ${assetId}`);
    return t;
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    for (const k of REQUIRED) if (req[k] === undefined || req[k] === null || req[k] === "") throw new OneClickError(400, `${k} should not be empty`);
    if (!/^\d+$/.test(req.amount) || req.amount === "0") throw new OneClickError(400, "amount must be a positive integer string");
    if ((req.confidentiality ?? "public") !== "public" && !this.opts.authenticated) {
      throw new OneClickError(401, "User authentication is required for confidential intent quotes");
    }
    const origin = this.token(req.originAsset);
    const dest = this.token(req.destinationAsset);
    if (req.swapType !== "EXACT_OUTPUT" && req.swapType !== "EXACT_INPUT") throw new OneClickError(400, "simulated backend supports EXACT_INPUT and EXACT_OUTPUT");

    // Bridge minimums per origin chain, as observed on the real API (see chains.ts routeMinimumUsdc).
    const minimum = BigInt(chainByKey(origin.blockchain)?.routeMinimumUsdc ?? 0);
    if (req.swapType === "EXACT_OUTPUT" && dest.blockchain === "near" && BigInt(req.amount) < minimum) {
      throw new OneClickError(400, `1Click HTTP 400: Amount is too low for bridge, try at least ${minimum}`);
    }
    const sameAsset = origin.assetId === dest.assetId;
    const stable = /USD/.test(origin.symbol);
    const feeFrac = sameAsset ? 0 : (stable ? 0.0035 : 0.007) + (origin.blockchain === "btc" ? 0.012 : origin.blockchain === "eth" ? 0.004 : 0.001);
    const slip = BigInt(Math.max(0, Math.round(req.slippageTolerance)));
    let amountOut: bigint;
    let minAmountIn: bigint;
    let amountIn: bigint;
    if (req.swapType === "EXACT_OUTPUT") {
      amountOut = BigInt(req.amount);
      const outUsd = (Number(amountOut) / 10 ** dest.decimals) * dest.price;
      const inUnits = ((outUsd * (1 + feeFrac)) / origin.price) * 10 ** Math.min(origin.decimals, 15);
      minAmountIn = BigInt(Math.max(1, Math.ceil(inUnits))) * 10n ** BigInt(Math.max(0, origin.decimals - 15));
      amountIn = minAmountIn + (minAmountIn * slip) / 10_000n;
    } else {
      amountIn = BigInt(req.amount);
      minAmountIn = amountIn;
      const inUsd = (Number(amountIn) / 10 ** origin.decimals) * origin.price;
      amountOut = BigInt(Math.floor(((inUsd * (1 - feeFrac)) / dest.price) * 10 ** dest.decimals));
    }
    const minAmountOut = req.swapType === "EXACT_OUTPUT" ? amountOut : amountOut - (amountOut * slip) / 10_000n;
    const usd = (v: bigint, t: TokenResponse) => ((Number(v) / 10 ** t.decimals) * t.price).toFixed(6);
    const now = this.opts.now();
    const timestamp = new Date(now).toISOString();
    const echo: QuoteRequest = { depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, ...req };
    const response: QuoteResponse = {
      correlationId: randomUUID(),
      timestamp,
      signature: `sim:${createHash("sha256").update(JSON.stringify(echo) + timestamp).digest("hex").slice(0, 64)}`,
      quoteRequest: echo,
      quote: {
        amountIn: amountIn.toString(), amountInFormatted: fmt(amountIn, origin.decimals), amountInUsd: usd(amountIn, origin),
        minAmountIn: minAmountIn.toString(), amountOut: amountOut.toString(), amountOutFormatted: fmt(amountOut, dest.decimals),
        amountOutUsd: usd(amountOut, dest), minAmountOut: minAmountOut.toString(), timeEstimate: TIME_ESTIMATE[origin.blockchain] ?? 30,
        refundFee: BigInt(Math.max(1, Math.round((0.005 / origin.price) * 10 ** Math.min(origin.decimals, 15)))).toString(), withdrawFee: "0",
      },
    };
    if (!req.dry) this.register(response, origin.blockchain);
    return response;
  }

  /** Gives a quote a simulated deposit address and starts tracking it. Used by dry mode for real dry quotes. */
  register(response: QuoteResponse, blockchain: string): QuoteResponse {
    const now = this.opts.now();
    const address = simAddressFor(blockchain, response.correlationId + now + Math.random());
    response.quote.depositAddress = address;
    response.quote.deadline = new Date(Date.parse(response.quoteRequest.deadline) + 3_600_000).toISOString();
    response.quote.timeWhenInactive = response.quote.deadline;
    this.quotes.set(address, { response, deposits: [], createdAt: now, fail: this.failNext });
    this.failNext = false;
    return response;
  }

  /** Simulated origin-chain transfer to a deposit address. Returns the simulated tx hash. */
  deposit(depositAddress: string, amount: string, txHash?: string): string {
    const q = this.quotes.get(depositAddress);
    if (!q) throw new OneClickError(404, `Deposit address ${depositAddress} not found`);
    if (!/^\d{1,40}$/.test(amount)) throw new OneClickError(400, "amount must be base units");
    const hash = txHash ?? `sim:0x${createHash("sha256").update(depositAddress + amount + this.opts.now() + Math.random()).digest("hex")}`;
    q.deposits.push({ txHash: hash, amount: BigInt(amount), at: this.opts.now() });
    return hash;
  }

  has(depositAddress: string): boolean {
    return this.quotes.has(depositAddress);
  }

  async status(depositAddress: string): Promise<StatusResponse> {
    const q = this.quotes.get(depositAddress);
    if (!q) throw new OneClickError(404, `Deposit address ${depositAddress} not found`);
    const now = this.opts.now();
    const { quote, quoteRequest } = q.response;
    const deposited = q.deposits.reduce((a, d) => a + d.amount, 0n);
    const first = q.deposits[0];
    const deadline = Date.parse(quoteRequest.deadline);
    const details: StatusResponse["swapDetails"] = {
      intentHashes: [], nearTxHashes: [], originChainTxHashes: q.deposits.map((d) => ({ hash: d.txHash, explorerUrl: "" })), destinationChainTxHashes: [],
      depositedAmount: deposited.toString(),
    };
    let status: SwapStatus;
    if (!first) status = now > deadline ? "REFUNDED" : "PENDING_DEPOSIT";
    else if (first.at > deadline) {
      status = "REFUNDED";
      details.refundedAmount = deposited.toString();
      details.refundReason = "DEADLINE_PASSED";
    } else if (now - first.at < this.opts.processingMs) status = now - first.at < this.opts.processingMs / 3 ? "KNOWN_DEPOSIT_TX" : "PROCESSING";
    else if (q.fail) {
      status = "FAILED";
      details.refundedAmount = deposited.toString();
      details.refundReason = "ROUTE_FAILED";
    } else if (deposited < BigInt(quote.minAmountIn)) {
      // Real 1Click waits for a top-up until the deadline; the simulation refunds after two processing windows.
      status = now - first.at < this.opts.processingMs * 2 ? "INCOMPLETE_DEPOSIT" : "REFUNDED";
      if (status === "REFUNDED") {
        details.refundedAmount = deposited.toString();
        details.refundReason = "PARTIAL_DEPOSIT";
      }
    } else {
      status = "SUCCESS";
      const used = BigInt(quote.minAmountIn);
      details.amountIn = used.toString();
      details.amountInUsd = ((Number(used) / Number(BigInt(quote.amountIn) || 1n)) * Number(quote.amountInUsd)).toFixed(6);
      details.amountOut = quote.amountOut;
      details.amountOutUsd = quote.amountOutUsd;
      details.refundedAmount = (deposited - used).toString();
      details.destinationChainTxHashes = [{ hash: `sim:${createHash("sha256").update("dest" + depositAddress).digest("hex").slice(0, 44)}`, explorerUrl: "" }];
      details.nearTxHashes = [details.destinationChainTxHashes[0]!.hash];
    }
    return { correlationId: randomUUID(), quoteResponse: q.response, status, updatedAt: new Date(now).toISOString(), swapDetails: details };
  }

  async submitDeposit(req: SubmitDepositTxRequest): Promise<StatusResponse> {
    return this.status(req.depositAddress);
  }
}

/**
 * Dry mode: quotes are real 1Click dry quotes (no deposit address is created upstream); the
 * deposit address and everything after it are simulated by the embedded backend.
 */
export class DryOneClick implements OneClick {
  readonly kind = "dry" as const;
  readonly sim: SimulatedOneClick;

  constructor(private readonly real: OneClick, opts: SimulatedOneClickOptions = {}) {
    this.sim = new SimulatedOneClick(opts);
  }

  tokens(): Promise<TokenResponse[]> {
    return this.real.tokens();
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    const res = await this.real.quote({ ...req, dry: true });
    if (req.dry) return res;
    const blockchain = (await this.real.tokens()).find((t) => t.assetId === req.originAsset)?.blockchain ?? "eth";
    res.quoteRequest = { ...res.quoteRequest, dry: false };
    return this.sim.register(res, blockchain);
  }

  status(depositAddress: string): Promise<StatusResponse> {
    return this.sim.status(depositAddress);
  }

  submitDeposit(req: SubmitDepositTxRequest): Promise<StatusResponse> {
    return this.sim.submitDeposit(req);
  }
}
