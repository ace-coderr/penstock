import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store, verifyReceipt } from "@penstock/core";
import { AccountChecker } from "../src/account-check";
import { startHarness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.stop());

const api = (p: string, init?: RequestInit) => fetch(`${h.base}/api/admin${p}`, init);

describe("seller console API", () => {
  it("summarises 30 days of books for the seller", async () => {
    const o = (await (await api("/overview")).json()) as { mode: string; seller: { nearAccount: string }; account: { exists: boolean; method: string }; receivedUsdc: string; revenueUsdc: string; payments: number; byChain: { chain: string }[]; daily: unknown[]; conversion: number; simulation: { label: string } };
    expect(o.mode).toBe("demo");
    expect(o.simulation.label).toMatch(/simulated/);
    expect(o.account).toMatchObject({ exists: true, method: "simulated" });
    expect(BigInt(o.receivedUsdc)).toBeGreaterThan(0n);
    expect(o.payments).toBeGreaterThanOrEqual(400);
    expect(o.byChain.length).toBeGreaterThanOrEqual(8);
    expect(o.daily).toHaveLength(30);
    expect(o.conversion).toBeGreaterThan(0);
    expect(o.conversion).toBeLessThan(1);
  });

  it("lists payments with filters and opens one with a verifiable receipt", async () => {
    const list = (await (await api("/payments?chain=sol&limit=5")).json()) as { total: number; payments: { id: string; originChain: string }[] };
    expect(list.payments.every((p) => p.originChain === "sol")).toBe(true);
    const one = (await (await api(`/payments/${list.payments[0]!.id}`)).json()) as { receipt: Parameters<typeof verifyReceipt>[0]; receiptValid: boolean; payment: { simulated: boolean } };
    expect(one.receiptValid).toBe(true);
    expect(verifyReceipt(one.receipt)).toBe(true);
    expect(one.payment.simulated).toBe(true);
    expect((await api("/payments/pay_doesnotexist")).status).toBe(404);
  });

  it("labels funnel drop-off reasons as inferred", async () => {
    const f = (await (await api("/funnel")).json()) as { note: string; stages: { stage: string; count: number }[]; inferredReasons: { reason: string }[] };
    expect(f.note).toMatch(/inferred/i);
    expect(f.stages.map((s) => s.stage)).toEqual(["probed", "quoted", "deposited", "paid"]);
    expect(f.stages[0]!.count).toBeGreaterThan(f.stages[3]!.count);
    expect(f.inferredReasons.length).toBeGreaterThan(0);
  });

  it("exports a CSV an accountant can use, safe against formula injection", async () => {
    const r = await api("/export.csv");
    expect(r.headers.get("content-type")).toMatch(/text\/csv/);
    expect(r.headers.get("content-disposition")).toMatch(/attachment; filename="penstock-tidewater-/);
    const lines = (await r.text()).trim().split("\r\n");
    expect(lines[0]).toBe("date_utc,entry_id,type,endpoint,description,gross_usdc,refund_usdc,upstream_cost_usdc,net_usdc,buyer_paid_amount,buyer_paid_asset,buyer_paid_chain,buyer_route_fee_usd,status,settlement_tx_near,origin_tx,payer,session_id,simulated");
    expect(lines.length).toBeGreaterThan(400);
    expect(lines.some((l) => l.includes(",session_refund,"))).toBe(true);
    expect(lines.slice(1).every((l) => !/(^|,)[=+@]/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes(",'-"))).toBe(true); // negative refunds are quoted, not formulas
  });

  it("protects a new endpoint and refuses unsafe upstreams", async () => {
    const post = (b: unknown) => api("/endpoints", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    expect((await post({ slug: "meta", upstreamUrl: "http://169.254.169.254/latest", priceUsd: "0.01" })).status).toBe(400);
    expect((await post({ slug: "creds", upstreamUrl: "https://u:p@example.com", priceUsd: "0.01" })).status).toBe(400);
    expect((await post({ slug: "Bad Slug", upstreamUrl: "https://example.com", priceUsd: "0.01" })).status).toBe(400);
    expect((await post({ slug: "neg", upstreamUrl: "https://example.com", priceUsd: "-1" })).status).toBe(400);
    const ok = await post({ slug: "fx-rates", upstreamUrl: "https://api.example.com/fx", priceUsd: "0.003", capabilities: ["fx"] });
    expect(ok.status).toBe(201);
    const r = await fetch(`${h.base}/p/tidewater/fx-rates`);
    expect(r.status).toBe(402);
    expect((await post({ slug: "fx-rates", upstreamUrl: "https://api.example.com/fx", priceUsd: "0.003" })).status).toBe(409);
  });
});

describe("admin auth", () => {
  it("requires the bearer token when ADMIN_TOKEN is set", async () => {
    const h2 = await startHarness({ ADMIN_TOKEN: "x".repeat(32) });
    try {
      expect((await fetch(`${h2.base}/api/admin/overview`)).status).toBe(401);
      expect((await fetch(`${h2.base}/api/admin/overview`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(`${h2.base}/api/admin/overview`, { headers: { authorization: `Bearer ${"x".repeat(32)}` } })).status).toBe(200);
    } finally {
      await h2.stop();
    }
  });
});

describe("seller account check", () => {
  const rpc = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  it("reports a missing NEAR account in plain words (dry/live via RPC)", async () => {
    const c = new AccountChecker("dry", new Store(":memory:"), "https://rpc.example", rpc({ jsonrpc: "2.0", error: { cause: { name: "UNKNOWN_ACCOUNT" }, message: "Server error" } }));
    const r = await c.check("ghost-seller.near");
    expect(r).toMatchObject({ exists: false, method: "rpc" });
    expect(r.message).toMatch(/does not exist.*1Click rejects/);
    const ok = new AccountChecker("live", new Store(":memory:"), "https://rpc.example", rpc({ jsonrpc: "2.0", result: { amount: "1" } }));
    expect((await ok.check("real.near")).exists).toBe(true);
    expect((await ok.check("Not An Account")).method).toBe("format");
  });
});
