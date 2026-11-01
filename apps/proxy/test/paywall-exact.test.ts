import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { verifyReceipt, type PaymentRequirements } from "@penstock/core";
import { buildExactPayload, isExactNear, simulatedNearWallet } from "@penstock/buyer-mcp";
import { get402, paidInit, startHarness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.stop());

const tides = () => `${h.base}/p/tidewater/tides?harbor=singapore`;

describe("paywall: standard exact scheme on NEAR", () => {
  it("answers an unpaid call with 402 and a v2 PAYMENT-REQUIRED header", async () => {
    const { res, required } = await get402(tides());
    expect(res.status).toBe(402);
    expect(required.x402Version).toBe(2);
    expect(required.resource.url).toBe(`${h.base}/p/tidewater/tides`);
    const exact = required.accepts.find(isExactNear)!;
    expect(exact).toMatchObject({ scheme: "exact", network: "near:mainnet", amount: "4000", payTo: "tidewater-data.near" });
    expect(res.headers.get("access-control-expose-headers")).toContain("PAYMENT-REQUIRED");
  });

  it("verifies a signed delegate with the official facilitator logic, settles, and forwards", async () => {
    const { required } = await get402(tides());
    const wallet = simulatedNearWallet("agent-one.near");
    const payload = await buildExactPayload(wallet, required, required.accepts.find(isExactNear)!);
    const res = await fetch(tides(), paidInit(payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { harbour: string; events: unknown[] };
    expect(body.harbour).toBe("Singapore");
    const settle = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    expect(settle.success).toBe(true);
    expect(settle.transaction.startsWith("sim:")).toBe(true);
    const receipt = JSON.parse(Buffer.from(res.headers.get("penstock-receipt")!, "base64url").toString());
    expect(verifyReceipt(receipt)).toBe(true);
    expect(receipt.body).toMatchObject({ amountUsdc: "4000", seller: "tidewater-data.near", simulated: true });
    const stored = h.proxy.store.getPayment(receipt.body.paymentId)!;
    expect(stored).toMatchObject({ status: "settled", method: "exact-near", payer: "agent-one.near", simulated: true });

    // Replaying the identical payload must not unlock the resource again.
    const replay = await fetch(tides(), paidInit(payload));
    expect(replay.status).toBe(402);
    const err = (await replay.json()) as { error: string };
    expect(err.error).toMatch(/already/);
  });

  it("rejects a payload whose accepted terms were tampered with (lower price)", async () => {
    const { required } = await get402(tides());
    const cheap: PaymentRequirements = { ...required.accepts.find(isExactNear)!, amount: "1" };
    const payload = await buildExactPayload(simulatedNearWallet(), required, cheap);
    const res = await fetch(tides(), paidInit(payload));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/do not match/);
  });

  it("rejects a delegate that pays someone else while claiming the seller's terms", async () => {
    const { required } = await get402(tides());
    const real = required.accepts.find(isExactNear)!;
    const forged = await buildExactPayload(simulatedNearWallet(), required, { ...real, payTo: "attacker.near" });
    const res = await fetch(tides(), paidInit({ ...forged, accepted: real }));
    expect(res.status).toBe(402);
    expect(h.proxy.store.listPayments({ limit: 5 }).every((p) => p.payer !== "attacker.near")).toBe(true);
  });

  it("rejects a payment made for a different resource", async () => {
    const { required } = await get402(tides());
    const payload = await buildExactPayload(simulatedNearWallet(), required, required.accepts.find(isExactNear)!);
    const res = await fetch(`${h.base}/p/tidewater/geocode?q=lagos`, paidInit(payload));
    expect(res.status).toBe(402);
  });

  it("refuses path traversal and encoded separators instead of forwarding them", async () => {
    for (const p of ["/p/tidewater/tides/..%2f..%2fadmin", "/p/tidewater/tides/%2e%2e/x"]) {
      const res = await fetch(h.base + p);
      expect([400, 404]).toContain(res.status);
    }
  });

  it("returns 404 for unknown sellers and endpoints", async () => {
    expect((await fetch(`${h.base}/p/nobody/tides`)).status).toBe(404);
    expect((await fetch(`${h.base}/p/tidewater/nothing`)).status).toBe(404);
  });
});

describe("paywall: MCP tool transport", () => {
  it("returns PaymentRequired as an isError tool result, then runs the tool once paid", async () => {
    const url = `${h.base}/p/tidewater/summarize`;
    const call = (meta?: Record<string, unknown>) => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "summarize", arguments: { text: "Berth 4 closed. Pilot required. Strong winds. Delays likely." }, ...(meta ? { _meta: meta } : {}) } }),
    }).then((r) => r.json() as Promise<{ result: { isError?: boolean; structuredContent: { accepts: PaymentRequirements[]; resource: { url: string }; x402Version: number; lines?: string[] }; _meta?: Record<string, { success?: boolean }> } }>);
    const first = await call();
    expect(first.result.isError).toBe(true);
    const required = first.result.structuredContent;
    const payload = await buildExactPayload(simulatedNearWallet(), required as never, required.accepts.find(isExactNear)!);
    const paid = await call({ "x402/payment": payload });
    expect(paid.result.isError).toBeFalsy();
    expect(paid.result.structuredContent.lines).toHaveLength(3);
    expect(paid.result._meta!["x402/payment-response"]!.success).toBe(true);
  });
});
