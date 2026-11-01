import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@penstock/core";
import { NEAR_INTENTS } from "./method";

/**
 * Buyer-side helpers for the near-intents method (draft PR #3370, "PaymentPayload payload Field").
 * Quote payload: { type: "quote", refundTo, slippageTolerance? }, accepted = unquoted entry.
 * Deposit payload: { type: "deposit", operationToken, depositAddress, depositMemo?, txHash }, accepted = unquoted entry.
 */

export function isNearIntentsEntry(r: PaymentRequirements): boolean {
  return r.scheme === "exact" && r.extra?.assetTransferMethod === NEAR_INTENTS;
}

export function isUnquoted(r: PaymentRequirements): boolean {
  return isNearIntentsEntry(r) && r.amount === "" && r.payTo === "";
}

export function buildQuotePayload(required: PaymentRequired, unquoted: PaymentRequirements, refundTo: string, slippageTolerance?: number): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: required.resource.url },
    accepted: unquoted,
    payload: { type: "quote", refundTo, ...(slippageTolerance !== undefined ? { slippageTolerance } : {}) },
  };
}

/** Finds the quoted entry in a second 402 for the same origin network and asset. */
export function findQuotedEntry(required: PaymentRequired, unquoted: PaymentRequirements): PaymentRequirements | undefined {
  return required.accepts.find((a) => isNearIntentsEntry(a) && typeof a.extra.operationToken === "string" && a.network === unquoted.network && a.asset.toLowerCase() === unquoted.asset.toLowerCase());
}

export interface DepositInstructions {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  depositMemo?: string;
  refundDeadline: string;
  operationToken: string;
}

export function depositInstructions(quoted: PaymentRequirements): DepositInstructions {
  return {
    network: quoted.network, asset: quoted.asset, amount: quoted.amount, payTo: quoted.payTo,
    ...(typeof quoted.extra.depositMemo === "string" ? { depositMemo: quoted.extra.depositMemo } : {}),
    refundDeadline: String(quoted.extra.refundDeadline), operationToken: String(quoted.extra.operationToken),
  };
}

export function buildDepositPayload(required: PaymentRequired, unquoted: PaymentRequirements, d: DepositInstructions, txHash: string): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: required.resource.url },
    accepted: unquoted,
    payload: { type: "deposit", operationToken: d.operationToken, depositAddress: d.payTo, ...(d.depositMemo ? { depositMemo: d.depositMemo } : {}), txHash },
  };
}
