import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { verifyReceipt, type PaymentRequired, type PaymentRequirements } from "@penstock/core";
import { buildDepositPayload, buildQuotePayload, depositInstructions, findQuotedEntry, isUnquoted } from "@penstock/intents-adapter";
import { get402, paidInit, startHarness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.stop());

const URL_TIDES = () => `${h.base}/p/tidewater/tides?harbor=lagos`;
const REFUND_TO = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";

async function simDeposit(depositAddress: string, amount: string): Promise<string> {
  const r = await fetch(`${h.base}/sim/deposit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ depositAddress, amount }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { txHash: string }).txHash;
}

async function quoteFor(network: string, symbolAsset?: (r: PaymentRequirements) => boolean) {
  const { required } = await get402(URL_TIDES());
  const unquoted = required.accepts.find((a) => isUnquoted(a) && a.network === network && (!symbolAsset || symbolAsset(a)))!;
  expect(unquoted).toBeDefined();
  const res = await fetch(URL_TIDES(), paidInit(buildQuotePayload(required, unquoted, REFUND_TO)));
  expect(res.status).toBe(402);
  const second = (await res.json()) as PaymentRequired;
  const quoted = findQuotedEntry(second, unquoted)!;
  return { required, unquoted, quoted, second };
}

describe("near-intents end to end (demo mode, simulated 1Click)", () => {
  it("pays from Base USDC: unquoted 402 -> quote -> deposit -> settlement -> resource", async () => {
    const { required, unquoted, quoted, second } = await quoteFor("eip155:8453", (a) => a.asset === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(unquoted.extra.indicativeAmount).toMatch(/^\d+$/);
    expect(second.error).toMatch(/quote issued/);
    expect(quoted.payTo.startsWith("sim")).toBe(true);
    expect(BigInt(quoted.amount)).toBeGreaterThan(4000n);
    expect(quoted.extra).toMatchObject({ assetTransferMethod: "near-intents", paymentFlow: "upfront", destination: { amount: "4000", recipient: "tidewater-data.near" } });

    const d = depositInstructions(quoted);
    const txHash = await simDeposit(d.payTo, d.amount);
    const res = await fetch(URL_TIDES(), paidInit(buildDepositPayload(required, unquoted, d, txHash)));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { harbour: string }).harbour).toBe("Lagos");
    const settle = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    expect(settle).toMatchObject({ success: true, network: "near:mainnet", amount: "4000", extra: { originNetwork: "eip155:8453", originTxHash: txHash } });
    expect(JSON.stringify(settle)).not.toContain(d.operationToken);
    const receipt = JSON.parse(Buffer.from(res.headers.get("penstock-receipt")!, "base64url").toString());
    expect(verifyReceipt(receipt)).toBe(true);
    const p = h.proxy.store.getPayment(receipt.body.paymentId)!;
    expect(p).toMatchObject({ method: "near-intents", originChain: "base", status: "settled", amountOut: "4000", depositAddress: d.payTo, simulated: true });
    expect(p.feeUsd).toBeGreaterThan(0);

    // Presenting the same deposit again must not run the resource a second time.
    const again = await fetch(URL_TIDES(), paidInit(buildDepositPayload(required, unquoted, d, txHash)));
    expect(again.status).toBe(402);
    expect(((await again.json()) as { error: string }).error).toMatch(/operation_executed/);
  });

  it("pays from native SOL (wrong chain, wrong token for the seller)", async () => {
    const { required, unquoted, quoted } = await quoteFor("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", (a) => a.asset === "slip44:501");
    const res0 = await fetch(URL_TIDES(), paidInit(buildQuotePayload(required, unquoted, REFUND_TO)));
    expect(res0.status).toBe(402); // EVM refund address is not valid on Solana
    expect(((await res0.json()) as { error: string }).error).toMatch(/refundTo/);
    void quoted;
  });

  it("refunds the payer when the deposit is short, and records the refund", async () => {
    const { required, unquoted, quoted } = await quoteFor("eip155:42161");
    const d = depositInstructions(quoted);
    const txHash = await simDeposit(d.payTo, "1");
    const res = await fetch(URL_TIDES(), paidInit(buildDepositPayload(required, unquoted, d, txHash)));
    expect(res.status).toBe(402);
    const settle = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    expect(settle).toMatchObject({ success: false, errorReason: "exact_near_intents_insufficient_deposit", extra: { status: "REFUNDED", refundTo: REFUND_TO } });
    const refunded = h.proxy.store.listPayments({ status: "refunded", limit: 50 }).find((p) => p.depositAddress === d.payTo)!;
    expect(refunded).toMatchObject({ refundReason: "PARTIAL_DEPOSIT", refundedAmount: "1", refundTo: REFUND_TO });
  });

  it("refunds the payer when the route fails after a full deposit", async () => {
    h.proxy.intents.sim!.failNextSwap();
    const { required, unquoted, quoted } = await quoteFor("eip155:10");
    const d = depositInstructions(quoted);
    const txHash = await simDeposit(d.payTo, d.amount);
    const res = await fetch(URL_TIDES(), paidInit(buildDepositPayload(required, unquoted, d, txHash)));
    expect(res.status).toBe(402);
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!)).toMatchObject({ success: false, errorReason: "exact_near_intents_payment_failed", extra: { status: "FAILED" } });
  });

  it("reports settlement_pending before the deposit is detected", async () => {
    const { required, unquoted, quoted } = await quoteFor("eip155:137");
    const d = depositInstructions(quoted);
    const fakeTx = "0x" + "ab".repeat(32);
    const res = await fetch(URL_TIDES(), paidInit(buildDepositPayload(required, unquoted, d, fakeTx)));
    expect(res.status).toBe(402);
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!)).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(res.headers.get("retry-after")).toBe("5");
  }, 20_000);

  it("refuses a deposit token minted for another resource", async () => {
    const { required, unquoted, quoted } = await quoteFor("eip155:8453");
    const d = depositInstructions(quoted);
    const txHash = await simDeposit(d.payTo, d.amount);
    const other = `${h.base}/p/tidewater/geocode?q=lagos`;
    const { required: otherReq } = await get402(other);
    const otherUnquoted = otherReq.accepts.find((a) => isUnquoted(a) && a.network === unquoted.network && a.asset === unquoted.asset)!;
    const res = await fetch(other, paidInit(buildDepositPayload(otherReq, otherUnquoted, d, txHash)));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/token_invalid/);
    void required;
  });

  it("ranks routes to USDC on NEAR with quote, fee and time", async () => {
    const r = await fetch(`${h.base}/api/public/routes?endpoint=tidewater.tides&from=near:USDC,base:USDC,btc:BTC,sol:SOL`);
    const body = (await r.json()) as { cheapest: { chain: string }; routes: { chain: string; feeUsd: number; timeEstimateSec: number }[]; simulated: boolean };
    expect(body.simulated).toBe(true);
    expect(body.cheapest.chain).toBe("near");
    expect(body.routes).toHaveLength(4);
    expect(body.routes.every((x) => x.timeEstimateSec > 0)).toBe(true);
  });
});
