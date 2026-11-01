import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

export type { PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo, SettleResponse, VerifyResponse };

export type Mode = "demo" | "dry" | "live";

/** How a payment reached the seller. */
export type PaymentMethod = "exact-near" | "near-intents" | "session";

export type PaymentStatus = "settled" | "pending" | "refunded" | "failed";

export interface Seller {
  id: string;
  name: string;
  nearAccount: string;
  description: string;
  /** Base URL of the seller's Penstock instance. Local sellers use the proxy's own URL. */
  origin: string;
  simulated: boolean;
}

export interface Endpoint {
  id: string;
  sellerId: string;
  slug: string;
  kind: "http" | "mcp";
  description: string;
  capabilities: string[];
  /** Price per call in USDC base units (6 decimals). */
  priceUsdc: string;
  upstreamUrl: string;
  /** HTTP methods the paywall forwards. */
  methods: string[];
  sessionsEnabled: boolean;
  /** For resale endpoints: upstream Penstock endpoints this one calls, as absolute URLs. */
  resaleOf: string[];
}

export interface Payment {
  id: string;
  ts: number;
  sellerId: string;
  endpointId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  originChain: string;
  originAsset: string;
  originSymbol: string;
  amountIn: string;
  amountInUsd: number;
  /** USDC base units the seller receives. */
  amountOut: string;
  feeUsd: number;
  payer: string;
  refundTo: string;
  depositAddress: string | null;
  originTx: string | null;
  destTx: string | null;
  refundedAmount: string | null;
  refundReason: string | null;
  operationId: string | null;
  sessionId: string | null;
  /** USDC base units this seller paid to upstream sellers for this call (resale). */
  upstreamCost: string;
  shielded: boolean;
  simulated: boolean;
  receiptSig: string | null;
}

export type FunnelStage = "probed" | "quoted" | "deposited" | "paid" | "refunded";

export interface Probe {
  id: string;
  ts: number;
  endpointId: string;
  /** Stable, non-reversible buyer handle (hash). Never an IP. */
  buyer: string;
  originChain: string | null;
  stage: FunnelStage;
  /** Inferred reason the buyer stopped at this stage. Always inferred from behaviour, never stated by the buyer. */
  inferredReason: string | null;
  paymentId: string | null;
  simulated: boolean;
}

export type SessionStatus = "open" | "closed";

export interface Session {
  id: string;
  sellerId: string;
  endpointId: string;
  buyer: string;
  capUsdc: string;
  fundedUsdc: string;
  spentUsdc: string;
  settledUsdc: string;
  status: SessionStatus;
  openedAt: number;
  closedAt: number | null;
  refundUsdc: string | null;
  fundingPaymentId: string;
  refundTo: string;
  originChain: string;
  simulated: boolean;
}

export interface SignedReceipt<T = Record<string, unknown>> {
  body: T;
  /** base64url ed25519 signature over the canonical JSON of body. */
  sig: string;
  /** base64url raw ed25519 public key. */
  pub: string;
}
