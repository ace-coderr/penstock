import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Endpoint } from "@penstock/core";
import { PenstockBuyer, parseHoldings, simulatedNearWallet, simulatedOriginWallet } from "@penstock/buyer-mcp";
import { resaleDelivery } from "../src/resale";
import { forwardDelivery } from "../src/paywall";
import { startHarness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.stop());

describe("agent-to-agent resale", () => {
  it("buys from two upstream Penstock sellers, then answers, and books the margin", async () => {
    const buyer = new PenstockBuyer({ directories: [], holdings: parseHoldings("near:USDC:1000000"), near: simulatedNearWallet("end-buyer.near") });
    const r = await buyer.call(`${h.base}/p/tidewater/harbor-brief?harbor=halifax`);
    expect(r).toMatchObject({ paid: true, status: 200, method: "exact-near" });
    const body = r.body as { harbour: string; weather: { windKt: number } | null; notice: { to: string } | null };
    expect(body.harbour).toBe("Halifax");
    expect(body.weather?.windKt).toBeGreaterThan(0); // paid upstream call 1: northwind.marine-weather
    expect(body.notice?.to).toBe("es"); // paid upstream call 2: quillfeed.translate

    const paymentId = (r.receipt as { body: { paymentId: string } }).body.paymentId;
    const p = h.proxy.store.getPayment(paymentId)!;
    expect(p).toMatchObject({ amountOut: "25000", upstreamCost: "14000" }); // margin 11000 = $0.011

    // The two upstream sellers were paid by Tidewater's own account.
    const upstream = h.proxy.store.listPayments({ limit: 50 }).filter((x) => x.payer === "tidewater-data.near" && x.ts >= p.ts - 60_000);
    expect(new Set(upstream.map((x) => x.endpointId))).toEqual(new Set(["northwind.marine-weather", "quillfeed.translate"]));

    const detail = (await (await fetch(`${h.base}/api/admin/payments/${paymentId}`)).json()) as { upstreamReceipts: { valid: boolean; body: { endpoint: string } }[] };
    expect(detail.upstreamReceipts.map((u) => u.body.endpoint).sort()).toEqual(["northwind.marine-weather", "quillfeed.translate"]);
    expect(detail.upstreamReceipts.every((u) => u.valid)).toBe(true);

    const eps = (await (await fetch(`${h.base}/api/admin/endpoints`)).json()) as { endpoints: { slug: string; marginPerCallUsdc: string | null }[] };
    expect(eps.endpoints.find((e) => e.slug === "harbor-brief")!.marginPerCallUsdc).not.toBeNull();
  });

  it("accumulates upstream cost on the funding payment for session-metered resale calls", async () => {
    // Holding only SOL: $0.025 is below the Solana bridge minimum, so the buyer opens a session.
    const buyer = new PenstockBuyer({ directories: [], holdings: parseHoldings("sol:SOL:90000000"), origins: [simulatedOriginWallet("sol", h.base)] });
    const a = await buyer.call(`${h.base}/p/tidewater/harbor-brief?harbor=lagos`);
    const b = await buyer.call(`${h.base}/p/tidewater/harbor-brief?harbor=mombasa`);
    expect([a.method, b.method]).toEqual(["session", "session"]);
    const sessionId = h.proxy.store.listSessions("tidewater", 50).find((s) => s.endpointId === "tidewater.harbor-brief" && s.status === "open")!.id;
    const funding = h.proxy.store.getPayment(h.proxy.store.getSession(sessionId)!.fundingPaymentId)!;
    expect(funding.upstreamCost).toBe("28000"); // two calls x (6000 + 8000)
    expect(JSON.parse(h.proxy.store.getKv(`resale:${funding.id}`)!)).toHaveLength(4);
    await buyer.closeSessions();
  });

  it("refuses payment for a resale endpoint in live mode until the seller configures a resale key", () => {
    const live = loadConfig({ MODE: "live", OPERATION_TOKEN_SECRET: "ab".repeat(32), ADMIN_TOKEN: "x".repeat(32), SELLER_NEAR_ACCOUNT: "s.near" });
    const d = resaleDelivery(forwardDelivery, live, {});
    const ep = { resaleOf: ["https://other.example/p/a/b"] } as Endpoint;
    expect(d.ready(ep)).toMatch(/RESALE_NEAR_KEY/);
    expect(resaleDelivery(forwardDelivery, live, { RESALE_NEAR_KEY: "ed25519:x" }).ready(ep)).toBeNull();
    expect(d.ready({ resaleOf: [] as string[] } as Endpoint)).toBeNull();
  });
});
