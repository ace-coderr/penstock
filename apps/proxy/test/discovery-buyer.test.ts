import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PenstockBuyer, createMcpHandler, parseHoldings, simulatedNearWallet, simulatedOriginWallet, DEMO_HOLDINGS } from "@penstock/buyer-mcp";
import { startHarness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.stop());

const dir = () => `${h.base}/.well-known/penstock.json`;

function demoBuyer(holdings = DEMO_HOLDINGS) {
  const hs = parseHoldings(holdings);
  return new PenstockBuyer({
    directories: [dir()], holdings: hs, near: simulatedNearWallet("demo-agent.near"),
    origins: [...new Set(hs.map((x) => x.chain))].filter((c) => c !== "near").map((c) => simulatedOriginWallet(c, h.base)),
  });
}

describe("discovery", () => {
  it("publishes endpoints, prices, accepted chains and the spec versions", async () => {
    const r = await fetch(dir());
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const doc = (await r.json()) as { simulated: boolean; destination: { network: string }; acceptedOrigins: { chain: string }[]; paymentMethods: { id: string; specSource?: string }[]; sellers: { id: string; endpoints: { id: string; url: string; priceUsd: string; sessions: unknown }[] }[] };
    expect(doc.simulated).toBe(true);
    expect(doc.destination.network).toBe("near:mainnet");
    expect(doc.acceptedOrigins.map((o) => o.chain)).toEqual(expect.arrayContaining(["near", "base", "sol", "btc", "eth"]));
    const ni = doc.paymentMethods.find((m) => m.id === "near-intents") as { specSource?: string; spec?: string; settlement?: { api: string; version: string } };
    expect(ni.spec).toBe("unofficial-draft");
    expect(ni.specSource).toContain("SPEC-NOTES.md");
    expect(ni.settlement).toMatchObject({ api: "1Click Swap API", version: "0.1.10" });
    const tides = doc.sellers.find((s) => s.id === "tidewater")!.endpoints.find((e) => e.id === "tidewater.tides")!;
    expect(tides).toMatchObject({ url: `${h.base}/p/tidewater/tides`, priceUsd: "0.004" });
    expect(tides.sessions).not.toBeNull();
    const one = (await (await fetch(`${dir()}?seller=northwind`)).json()) as { sellers: unknown[] };
    expect(one.sellers).toHaveLength(1);
  });
});

describe("buyer", () => {
  it("searches by capability and price, cheapest first", async () => {
    const results = await demoBuyer().search("marine", 0.008);
    expect(results.map((r) => r.id)).toEqual(["tidewater.tides", "northwind.marine-weather"]);
    expect(await demoBuyer().search("translate", 0.001)).toEqual([]);
  });

  it("pays from the wrong chain with the wrong token: picks the cheapest holding automatically", async () => {
    const r = await demoBuyer().call(`${h.base}/p/tidewater/voyage-plan?harbor=mombasa`);
    expect(r.paid).toBe(true);
    expect(r.status).toBe(200);
    expect((r.body as { harbour: string }).harbour).toBe("Mombasa");
    expect(r).toMatchObject({ method: "near-intents", originChain: "base", originSymbol: "USDC" });
    expect(r.settlement).toMatchObject({ success: true, network: "near:mainnet", amount: "250000" });
  });

  it("funds a prepaid session automatically when the price is below every route minimum", async () => {
    const buyer = demoBuyer();
    const first = await buyer.call(`${h.base}/p/tidewater/tides?harbor=mombasa`);
    expect(first).toMatchObject({ paid: true, status: 200, method: "session", originChain: "arb" });
    expect(first.note).toMatch(/opened a \$0.1 session via near-intents from ETH on arb/);
    const second = await buyer.call(`${h.base}/p/tidewater/tides?harbor=lagos`);
    expect(second).toMatchObject({ paid: true, method: "session" });
    expect(second.note).toMatch(/remaining=92000/);
    const closed = (await buyer.closeSessions()) as { receipt: { body: { refundUsdc: string; refundState: string } } }[];
    expect(closed[0]!.receipt.body).toMatchObject({ refundUsdc: "92000", refundState: "simulated" });
  });

  it("uses USDC on NEAR directly when the agent holds it", async () => {
    const r = await demoBuyer("near:USDC:1000000,btc:BTC:20000").call(`${h.base}/p/tidewater/geocode?q=halifax`);
    expect(r).toMatchObject({ paid: true, method: "exact-near", originChain: "near" });
  });

  it("does not pay above maxUsd, and reports when no holding can pay", async () => {
    const tooCheap = await demoBuyer().call(`${h.base}/p/tidewater/harbor-brief?harbor=lagos`, {}, 0.001);
    expect(tooCheap.paid).toBe(false);
    expect(tooCheap.note).toMatch(/above maxUsd/);
    const none = await new PenstockBuyer({ directories: [dir()], holdings: parseHoldings("btc:BTC:20000"), origins: [simulatedOriginWallet("btc", h.base)] }).call(`${h.base}/p/tidewater/tides`);
    expect(none.paid).toBe(false);
    expect(none.note).toMatch(/no holding can pay this endpoint \(BTC@btc needs at least \$6.454605\)/);
  });
});

describe("buyer MCP server", () => {
  it("lists its tools and pays through penstock_call", async () => {
    const handle = createMcpHandler(demoBuyer());
    const init = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize" })) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const list = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["penstock_search", "penstock_routes", "penstock_call", "penstock_resume"]);
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const search = (await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "penstock_search", arguments: { capability: "tides" } } })) as { result: { structuredContent: { results: { url: string }[] } } };
    const url = search.result.structuredContent.results[0]!.url;
    const routes = (await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "penstock_routes", arguments: { url } } })) as { result: { structuredContent: { routes: { chain: string; minAmountOut?: string }[] } } };
    expect(routes.result.structuredContent.routes.every((r) => r.minAmountOut)).toBe(true); // $0.004 is below every bridge minimum
    const call = (await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "penstock_call", arguments: { url: `${url}?harbor=rotterdam` } } })) as { result: { isError?: boolean; structuredContent: { paid: boolean; receipt: unknown } } };
    expect(call.result.isError).toBeUndefined();
    expect(call.result.structuredContent.paid).toBe(true);
    expect(call.result.structuredContent.receipt).toBeDefined();
  });
});
