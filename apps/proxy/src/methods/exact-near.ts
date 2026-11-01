import { randomUUID } from "node:crypto";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactNearScheme } from "@x402/near/exact/facilitator";
import { decodeSignedDelegateB64, settlementCacheKey, EMPTY_CONTRACT_CODE_HASH, type FacilitatorNearSigner } from "@x402/near";
import {
  DESTINATION, formatUnits, simNearBlockHeight,
  type Endpoint, type PaymentPayload, type PaymentRequirements, type ResourceInfo, type Seller, type SettleResponse, type VerifyResponse,
} from "@penstock/core";
import type { MethodContext, MethodOutcome, PaymentMethodHandler } from "./types";

/**
 * Standard x402 `exact` on NEAR (@x402/near): the buyer signs a NEP-366 delegate action with one
 * USDC `ft_transfer` straight to the seller's account. Penstock never holds these funds.
 *
 * live: verification and settlement go to an x402 facilitator (FACILITATOR_URL, API key).
 * demo/dry: the official ExactNearScheme facilitator logic runs in-process against a simulated
 * chain-state signer, so the signature, the single-transfer rule, payee, amount and nonce window
 * are checked for real; only chain reads and the relayed transaction are simulated.
 */

export interface ExactFacilitator {
  verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse>;
}

/** In-memory NEAR chain state for demo and dry mode. Never used in live mode. */
export class SimulatedNearChain implements FacilitatorNearSigner {
  private readonly nonces = new Map<string, bigint>();
  readonly relayer = "sim-relayer.near";

  getRelayerIds(): readonly string[] {
    return [this.relayer];
  }

  async getCurrentBlockHeight(): Promise<bigint> {
    return simNearBlockHeight();
  }

  async viewAccount(input: { network: string; accountId: string }) {
    // The USDC contract has code; every other account is a plain account that exists.
    return { codeHash: input.accountId === DESTINATION.asset ? "SimCodeHash11111111111111111111111111111111" : EMPTY_CONTRACT_CODE_HASH };
  }

  async viewAccessKey(input: { network: string; accountId: string; publicKey: string }) {
    return { nonce: this.nonces.get(`${input.accountId}|${input.publicKey}`) ?? 0n, permissionKind: "FullAccess" as const };
  }

  async ftBalanceOf(): Promise<bigint> {
    return 1_000_000_000n; // 1,000 simulated USDC per payer
  }

  async storageBalanceOf() {
    return { supported: true as const, registered: true };
  }

  async submitSignedDelegateAction(input: { network: string; relayerId: string; signedDelegateAction: string }) {
    const d = decodeSignedDelegateB64(input.signedDelegateAction).delegate;
    this.nonces.set(`${d.senderId}|${d.publicKey}`, d.nonce);
    return { transaction: `sim:${settlementCacheKey(input.signedDelegateAction).slice(0, 44)}`, innerReceipt: { kind: "success" as const, value: "" } };
  }
}

export function simulatedExactFacilitator(chain: FacilitatorNearSigner = new SimulatedNearChain()): ExactFacilitator {
  const scheme = new ExactNearScheme(chain);
  return { verify: (p, r) => scheme.verify(p, r), settle: (p, r) => scheme.settle(p, r) };
}

export function httpExactFacilitator(url: string, apiKey: string | null): ExactFacilitator {
  const auth = apiKey ? { "X-API-Key": apiKey } : undefined;
  const client = new HTTPFacilitatorClient({
    url,
    timeoutMs: 60_000,
    createAuthHeaders: auth ? async () => ({ verify: auth, settle: auth, supported: auth }) : undefined,
  });
  return { verify: (p, r) => client.verify(p, r), settle: (p, r) => client.settle(p, r) };
}

export class ExactNearMethod implements PaymentMethodHandler {
  readonly id = "exact-near" as const;

  constructor(private readonly facilitator: ExactFacilitator, readonly simulated: boolean, private readonly maxTimeoutSeconds = 120) {}

  async offers(endpoint: Endpoint, seller: Seller, _resource: ResourceInfo): Promise<PaymentRequirements[]> {
    return [{
      scheme: "exact", network: DESTINATION.network, asset: DESTINATION.asset, amount: endpoint.priceUsdc,
      payTo: seller.nearAccount, maxTimeoutSeconds: this.maxTimeoutSeconds, extra: { name: "USDC", decimals: DESTINATION.decimals },
    }];
  }

  owns(accepted: PaymentRequirements): boolean {
    return accepted?.scheme === "exact" && accepted.network === DESTINATION.network && !accepted.extra?.assetTransferMethod;
  }

  match(accepted: PaymentRequirements, offers: PaymentRequirements[]): PaymentRequirements | null {
    return offers.find((o) => this.owns(o) && o.asset === accepted.asset && o.payTo === accepted.payTo && o.amount === accepted.amount) ?? null;
  }

  async process(payload: PaymentPayload, req: PaymentRequirements, ctx: MethodContext): Promise<MethodOutcome> {
    const sda = (payload.payload as { signedDelegateAction?: unknown }).signedDelegateAction;
    if (typeof sda !== "string" || sda.length === 0 || sda.length > 8192) {
      return { kind: "rejected", reason: "invalid_payload", message: "payload.signedDelegateAction must be a base64 string" };
    }
    let operationId: string;
    try {
      decodeSignedDelegateB64(sda);
      operationId = `exact:${settlementCacheKey(sda)}`;
    } catch {
      return { kind: "rejected", reason: "invalid_payload", message: "signedDelegateAction is not a valid base64 Borsh SignedDelegate" };
    }
    const owner = randomUUID();
    const claim = ctx.store.claimOperation(operationId, owner, 90_000, ctx.now());
    if (claim.state === "busy") return { kind: "pending", settle: { success: false, errorReason: "settlement_pending", transaction: "", network: req.network } };
    if (claim.state === "recorded") return { kind: "rejected", reason: "payment_already_used", message: "this payment has already been redeemed" };

    try {
      const verify = await this.facilitator.verify(payload, req);
      if (!verify.isValid) {
        ctx.store.releaseClaim(operationId, owner);
        return { kind: "rejected", reason: verify.invalidReason ?? "invalid_payment", message: verify.invalidMessage ?? "payment did not verify" };
      }
      const settle = await this.facilitator.settle(payload, req);
      if (!settle.success) {
        ctx.store.releaseClaim(operationId, owner);
        return { kind: "rejected", reason: settle.errorReason ?? "settlement_failed", message: settle.errorMessage ?? "settlement failed", settle };
      }
      ctx.store.recordResult(operationId, owner, settle, ctx.now());
      const amountUsd = Number(formatUnits(req.amount, DESTINATION.decimals));
      const payer = settle.payer ?? verify.payer ?? "unknown";
      return {
        kind: "settled", settle, operationId,
        fields: {
          method: "exact-near", originChain: "near", originAsset: req.asset, originSymbol: "USDC", amountIn: req.amount, amountInUsd: amountUsd,
          amountOut: req.amount, feeUsd: 0, payer, refundTo: payer, depositAddress: null,
          originTx: settle.transaction, destTx: settle.transaction, operationId, shielded: false,
        },
      };
    } catch (e) {
      // Indeterminate (e.g. facilitator timeout): the claim stays until it expires, so a retry cannot double-settle.
      return { kind: "rejected", reason: "settlement_indeterminate", message: (e as Error).message.slice(0, 200) };
    }
  }
}
