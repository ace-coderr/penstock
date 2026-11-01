import type { Store } from "./store";
import type { Endpoint, Payment, PaymentMethod, PaymentPayload, PaymentRequirements, ResourceInfo, Seller, SettleResponse } from "./types";

export interface MethodContext {
  store: Store;
  now(): number;
  /** Rate-limit check for costly actions (e.g. minting a quote); false means refuse. */
  allow?(action: string): boolean;
}

/** Ledger fields a method fills in once a payment settles. */
export type SettledPaymentFields = Pick<Payment,
  "method" | "originChain" | "originAsset" | "originSymbol" | "amountIn" | "amountInUsd" | "amountOut" | "feeUsd" |
  "payer" | "refundTo" | "depositAddress" | "originTx" | "destTx" | "operationId" | "shielded">;

export type MethodOutcome =
  | { kind: "settled"; settle: SettleResponse; fields: SettledPaymentFields; operationId: string }
  /** near-intents only: a quote was minted; respond with a second 402 carrying this entry. */
  | { kind: "quoted"; quoted: PaymentRequirements; buyerChain: string }
  | { kind: "pending"; settle: SettleResponse }
  /**
   * Payment refused or failed. `refund` is set when funds moved and were returned to the payer
   * (near-intents REFUNDED/FAILED), so the ledger can record the refund.
   */
  | { kind: "rejected"; reason: string; message: string; settle?: SettleResponse; refund?: SettledPaymentFields & { refundedAmount: string | null; refundReason: string | null } };

export interface MethodMeta {
  endpoint: Endpoint;
  seller: Seller;
  buyer: string;
  resource: ResourceInfo;
}

export interface PaymentMethodHandler {
  readonly id: PaymentMethod;
  /** True when settlement is simulated in the current mode. */
  readonly simulated: boolean;
  /** The entries this method contributes to `accepts[]` for an endpoint. */
  offers(endpoint: Endpoint, seller: Seller, resource: ResourceInfo): Promise<PaymentRequirements[]>;
  /** Whether an `accepted` entry from a client belongs to this method. */
  owns(accepted: PaymentRequirements): boolean;
  /** Finds the server's own entry corresponding to the client's `accepted`, or null. */
  match(accepted: PaymentRequirements, offers: PaymentRequirements[]): PaymentRequirements | null;
  process(payload: PaymentPayload, requirements: PaymentRequirements, ctx: MethodContext, meta: MethodMeta): Promise<MethodOutcome>;
}
