import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimulatedOneClick } from "@penstock/intents-adapter";
import { PenstockBuyer, createMcpHandler, parseHoldings, simulatedNearWallet, simulatedOriginWallet } from "../src/index";
import { startHarness, type Harness } from "../../../apps/proxy/test/helpers";

let h: Harness;
let sim: SimulatedOneClick;
beforeEach(async () => {
  sim = new SimulatedOneClick({ processingMs: 40 });
  h = await startHarness({}, { oneClick: sim });
});
afterEach(() => h.stop());

describe("a retry on a session-metered endpoint", () => {
  it("spends the session, not a new deposit", async () => {
    const hs = parseHoldings("arb:ETH:900000000000000");
    const buyer = new PenstockBuyer({ directories: [`${h.base}/.well-known/penstock.json`], holdings: hs, near: simulatedNearWallet("a.near"), origins: [simulatedOriginWallet("arb", h.base)] });
    const handle = createMcpHandler(buyer);
    const call = async () => ((await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "penstock_call", arguments: { url: `${h.base}/p/tidewater/tides?harbor=lagos` } } })) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result;

    // The first call opens a session (one deposit) and is metered against it, while the upstream is down once.
    const real = h.proxy.ctx.delivery;
    let down = true;
    h.proxy.ctx.delivery = { ...real, async deliver(ctx, endpoint, req, payment) { if (down) { down = false; throw new Error("injected upstream outage"); } return real.deliver(ctx, endpoint, req, payment); } };
    const first = await call();
    expect(first.isError).toBe(true);
    expect(sim.depositStats().count).toBe(1);

    const retry = await call();
    expect(retry.isError).toBeUndefined();
    expect(retry.structuredContent.paid).toBe(true);
    expect(sim.depositStats().count).toBe(1); // no new deposit: the retry was metered against the open session
    expect(retry.structuredContent.method).toBe("session");
  });
});
