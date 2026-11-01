import { describe, expect, it } from "vitest";
import { ShieldedRoutes } from "@penstock/shielded";
import { PenstockBuyer, parseHoldings, simulatedOriginWallet } from "@penstock/buyer-mcp";
import { SimulatedOneClick } from "@penstock/intents-adapter";
import { startHarness } from "./helpers";

const rpc = (result: unknown) => (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))) as unknown as typeof fetch;

describe("shielded routes: states", () => {
  it("is off by default and says why, and payments stay public", async () => {
    const s = new ShieldedRoutes({ mode: "demo", confidentialIntents: false, oneClickJwt: null, auroraRpcUrl: null });
    const st = await s.status();
    expect(st.active).toBeNull();
    expect(st.routes.map((r) => [r.id, r.enabled])).toEqual([["confidential-intents", false], ["aurora", false]]);
    expect(st.routes[1]!.reason).toMatch(/SHIELDED_AURORA_RPC_URL/);
    expect(st.scope.doesNotHide).toMatch(/revenue is visible/);
    expect(s.level()).toBe("public");
  });

  it("needs a 1Click JWT outside demo mode, and turns itself off after a runtime refusal", async () => {
    const dry = new ShieldedRoutes({ mode: "dry", confidentialIntents: true, oneClickJwt: null, auroraRpcUrl: null });
    expect((await dry.status()).routes[0]!.reason).toMatch(/HTTP 401 without ONECLICK_JWT/);
    const live = new ShieldedRoutes({ mode: "live", confidentialIntents: true, oneClickJwt: "jwt", auroraRpcUrl: null });
    expect(live.level()).toBe("basic");
    live.unavailable("1Click HTTP 401: token expired");
    expect(live.level()).toBe("public");
    expect((await live.status()).routes[0]!.reason).toMatch(/Turned off at runtime/);
  });

  it("connects to an Aurora private chain but does not claim it can route payments", async () => {
    const s = new ShieldedRoutes({ mode: "dry", confidentialIntents: false, oneClickJwt: null, auroraRpcUrl: "https://aurora.example", fetchImpl: rpc("0x4e454152") });
    const a = (await s.status()).routes.find((r) => r.id === "aurora")!;
    expect(a.enabled).toBe(false);
    expect(a.reason).toMatch(/Connected to chain 1313161554, but not enabled for payments: 1Click lists no assets/);
  });
});

const buyerOn = (base: string) => new PenstockBuyer({ directories: [], holdings: parseHoldings("base:USDC:5000000"), origins: [simulatedOriginWallet("base", base)] });

describe("shielded payer end to end (demo)", () => {
  it("requests confidential quotes when enabled and books the payment as shielded", async () => {
    const h = await startHarness({ SHIELDED_CONFIDENTIAL_INTENTS: "true" });
    try {
      const r = await buyerOn(h.base).call(`${h.base}/p/tidewater/voyage-plan?harbor=lagos`);
      expect(r).toMatchObject({ paid: true, method: "near-intents" });
      const id = (r.receipt as { body: { paymentId: string } }).body.paymentId;
      expect(h.proxy.store.getPayment(id)!.shielded).toBe(true);
      const doc = (await (await fetch(`${h.base}/.well-known/penstock.json`)).json()) as { shieldedPayer: { active: string } };
      expect(doc.shieldedPayer.active).toBe("confidential-intents");
      const admin = (await (await fetch(`${h.base}/api/admin/shielded`)).json()) as { shieldedPayments: number };
      expect(admin.shieldedPayments).toBeGreaterThanOrEqual(1);
    } finally {
      await h.stop();
    }
  });

  it("falls back to a public quote when 1Click refuses the confidential one, and keeps working", async () => {
    const h = await startHarness({ SHIELDED_CONFIDENTIAL_INTENTS: "true" }, { oneClick: new SimulatedOneClick({ authenticated: false }) });
    try {
      const r = await buyerOn(h.base).call(`${h.base}/p/tidewater/voyage-plan?harbor=lagos`);
      expect(r.paid).toBe(true);
      const id = (r.receipt as { body: { paymentId: string } }).body.paymentId;
      expect(h.proxy.store.getPayment(id)!.shielded).toBe(false);
      const st = await h.proxy.shielded.status();
      expect(st.active).toBeNull();
      expect(st.routes[0]!.reason).toMatch(/Turned off at runtime: .*authentication is required/);
    } finally {
      await h.stop();
    }
  });
});
