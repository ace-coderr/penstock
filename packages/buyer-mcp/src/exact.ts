import { ExactNearScheme } from "@x402/near/exact/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@penstock/core";
import type { NearWallet } from "./near-wallet";

/** Builds an x402 v2 PaymentPayload for a standard `exact` NEAR entry with the official client scheme. */
export async function buildExactPayload(wallet: NearWallet, required: PaymentRequired, requirement: PaymentRequirements): Promise<PaymentPayload> {
  const partial = await new ExactNearScheme(wallet).createPaymentPayload(2, requirement);
  return { x402Version: 2, resource: required.resource, accepted: requirement, payload: partial.payload };
}

export function isExactNear(r: PaymentRequirements): boolean {
  return r.scheme === "exact" && r.network.startsWith("near:") && !r.extra?.assetTransferMethod;
}
