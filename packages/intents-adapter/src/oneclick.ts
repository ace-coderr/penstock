/**
 * 1Click Swap API client: the documented NEAR Intents integration
 * (https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api).
 * Field names are copied from the official OpenAPI document, `info.version: 0.1.10`
 * (https://1click.chaindefuser.com/docs/v0/openapi.yaml, re-checked against the docs on 2026-11-02);
 * see docs/SPEC-NOTES.md section 5.
 */
import { verifyQuoteSignature } from "./quote-signature";

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type Confidentiality = "public" | "basic" | "advanced";
export type SwapStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

export const TERMINAL_STATUSES: ReadonlySet<SwapStatus> = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export interface TokenResponse {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
}

export interface QuoteRequest {
  dry: boolean;
  depositMode?: "SIMPLE" | "MEMO";
  swapType: SwapType;
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: DepositType;
  recipient: string;
  recipientType: RecipientType;
  deadline: string;
  confidentiality?: Confidentiality;
  referral?: string;
  quoteWaitingTimeMs?: number;
  appFees?: { recipient: string; fee: number }[];
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export interface TransactionDetails {
  hash: string;
  explorerUrl: string;
}

export interface SwapDetails {
  intentHashes: string[];
  nearTxHashes: string[];
  amountIn?: string;
  amountInUsd?: string;
  amountOut?: string;
  amountOutUsd?: string;
  originChainTxHashes: TransactionDetails[];
  destinationChainTxHashes: TransactionDetails[];
  refundedAmount?: string;
  refundReason?: string;
  depositedAmount?: string;
}

export interface StatusResponse {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: SwapStatus;
  updatedAt: string;
  swapDetails: SwapDetails;
}

export interface SubmitDepositTxRequest {
  txHash: string;
  depositAddress: string;
  nearSenderAccount?: string;
  memo?: string;
}

export class OneClickError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface OneClick {
  /** "http": real 1Click. "dry": real dry quotes, simulated deposits. "simulated": fully simulated. */
  readonly kind: "http" | "dry" | "simulated";
  tokens(): Promise<TokenResponse[]>;
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  status(depositAddress: string, depositMemo?: string): Promise<StatusResponse>;
  submitDeposit(req: SubmitDepositTxRequest): Promise<StatusResponse>;
}

const BASE_UNITS = /^\d{1,40}$/;

/** Minimal runtime check so a changed or tampered response fails loudly instead of being trusted. */
export function assertQuoteResponse(x: unknown, expectDeposit: boolean): QuoteResponse {
  const r = x as QuoteResponse;
  if (!r || typeof r !== "object" || !r.quote || !r.quoteRequest) throw new OneClickError(502, "1Click quote response is missing quote or quoteRequest");
  for (const k of ["amountIn", "minAmountIn", "amountOut", "minAmountOut"] as const) {
    if (!BASE_UNITS.test(String(r.quote[k]))) throw new OneClickError(502, `1Click quote.${k} is not a base-unit integer`);
  }
  if (typeof r.quote.timeEstimate !== "number") throw new OneClickError(502, "1Click quote.timeEstimate missing");
  if (expectDeposit && (typeof r.quote.depositAddress !== "string" || r.quote.depositAddress.length < 8)) {
    throw new OneClickError(502, "1Click quote has no depositAddress");
  }
  return r;
}

export function assertStatusResponse(x: unknown): StatusResponse {
  const r = x as StatusResponse;
  const ok = ["KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"];
  if (!r || typeof r !== "object" || !ok.includes(r.status) || !r.quoteResponse?.quoteRequest) throw new OneClickError(502, "1Click status response has an unexpected shape");
  r.swapDetails = r.swapDetails ?? { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] };
  r.swapDetails.originChainTxHashes = r.swapDetails.originChainTxHashes ?? [];
  r.swapDetails.destinationChainTxHashes = r.swapDetails.destinationChainTxHashes ?? [];
  return r;
}

export interface HttpOneClickOptions {
  baseUrl: string;
  /** Optional partner JWT, sent as the documented `X-API-Key` header. Never logged. */
  jwt?: string | null;
  timeoutMs?: number;
  /** Check 1Click's ed25519 signature on every quote (default true). */
  verifySignatures?: boolean;
  fetchImpl?: typeof fetch;
}

/** Real 1Click over HTTPS. */
export class HttpOneClick implements OneClick {
  readonly kind = "http" as const;
  private tokenCache: { at: number; list: TokenResponse[] } | null = null;
  private readonly f: typeof fetch;

  constructor(private readonly opts: HttpOneClickOptions) {
    this.f = opts.fetchImpl ?? fetch;
  }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) };
    // X-API-Key is the documented header; `Authorization: Bearer` is marked legacy in the OpenAPI document.
    if (this.opts.jwt) headers["x-api-key"] = this.opts.jwt;
    const res = await this.f(`${this.opts.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new OneClickError(502, `1Click returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const msg = (body as { message?: unknown })?.message;
      throw new OneClickError(res.status, `1Click HTTP ${res.status}: ${typeof msg === "string" ? msg.slice(0, 200) : "error"}`);
    }
    return body;
  }

  async tokens(): Promise<TokenResponse[]> {
    if (this.tokenCache && Date.now() - this.tokenCache.at < 600_000) return this.tokenCache.list;
    const list = (await this.call("/v0/tokens")) as TokenResponse[];
    if (!Array.isArray(list)) throw new OneClickError(502, "1Click tokens response is not an array");
    this.tokenCache = { at: Date.now(), list };
    return list;
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    const res = assertQuoteResponse(await this.call("/v0/quote", { method: "POST", body: JSON.stringify(req) }), !req.dry);
    // A quote whose signature does not verify may have been altered in transit (deposit address,
    // amounts): refuse it rather than send a payer to it.
    if (this.opts.verifySignatures !== false && !verifyQuoteSignature(res)) throw new OneClickError(502, "1Click quote signature did not verify");
    return res;
  }

  async status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo) q.set("depositMemo", depositMemo);
    return assertStatusResponse(await this.call(`/v0/status?${q}`));
  }

  async submitDeposit(req: SubmitDepositTxRequest): Promise<StatusResponse> {
    return assertStatusResponse(await this.call("/v0/deposit/submit", { method: "POST", body: JSON.stringify(req) }));
  }
}

/**
 * 1Click refuses amounts below a per-route bridge minimum with HTTP 400
 * "Amount is too low for bridge, try at least N" (N in destination base units; seen live
 * 2026-11-01). Returns N, or null if the error is something else.
 */
export function parseRouteMinimum(message: string): bigint | null {
  const m = /too low for bridge, try at least (\d{1,30})/i.exec(message);
  return m ? BigInt(m[1]!) : null;
}
