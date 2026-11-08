import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaymentMethodHandler } from "@penstock/core";
import { PenstockBuyer, createMcpHandler, parseHoldings, simulatedNearWallet, simulatedOriginWallet } from "../src/index";
import { startHarness, type Harness } from "../../../apps/proxy/test/helpers";

/**
 * A scripted "retry-happy agent" (no LLM). It makes one paid penstock_call, which fails AFTER the
 * deposit settled, and then does what most agents did in the field: calls penstock_call again with
 * the same arguments. The seller must receive ONE deposit, whatever the agent does next.
 *
 * Failure injection:
 *   settle    the seller side throws right after settlement succeeded (the deposit is real, the
 *             HTTP answer is an error)
 *   upstream  settlement succeeds, then the upstream API is down (HTTP 502 after payment)
 */

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.stop());

type Failure = "none" | "settle" | "upstream";

/** Makes the next near-intents deposit/settle step fail after it succeeded, or the upstream fail once. */
function inject(failure: Failure): void {
  if (failure === "settle") {
    const real = h.proxy.ctx.methods.find((m) => m.id === "near-intents")!;
    let armed = true;
    const wrapped = Object.create(real) as PaymentMethodHandler;
    wrapped.process = async (payload, req, ctx, meta) => {
      const out = await real.process(payload, req, ctx, meta);
      if (armed && (payload.payload as { type?: string }).type === "deposit" && out.kind === "settled") {
        armed = false;
        throw new Error("injected failure after settlement");
      }
      return out;
    };
    h.proxy.ctx.methods = h.proxy.ctx.methods.map((m) => (m === real ? wrapped : m));
  }
  if (failure === "upstream") {
    const real = h.proxy.ctx.delivery;
    let armed = true;
    h.proxy.ctx.delivery = {
      ...real,
      async deliver(ctx, endpoint, req, payment) {
        if (armed) {
          armed = false;
          throw new Error("injected upstream outage");
        }
        return real.deliver(ctx, endpoint, req, payment);
      },
    };
  }
}

function agentBuyer(): { buyer: PenstockBuyer; walletDeposits: () => number } {
  const hs = parseHoldings("base:USDC:2500000");
  const wallet = simulatedOriginWallet("base", h.base);
  let n = 0;
  const counted = { ...wallet, async deposit(d: Parameters<typeof wallet.deposit>[0]) { n++; return wallet.deposit(d); } };
  const buyer = new PenstockBuyer({ directories: [`${h.base}/.well-known/penstock.json`], holdings: hs, near: simulatedNearWallet("agent.near"), origins: [counted] });
  return { buyer, walletDeposits: () => n };
}

/** The agent: one MCP tool call per attempt, retrying while the result is an error. */
async function retryHappyAgent(buyer: PenstockBuyer, url: string, attempts: number, args: Record<string, unknown> = {}) {
  const handle = createMcpHandler(buyer);
  const results: { isError: boolean; structured: Record<string, unknown> }[] = [];
  for (let i = 0; i < attempts; i++) {
    const res = (await handle({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "penstock_call", arguments: { url, ...args } } })) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
    results.push({ isError: !!res.result.isError, structured: res.result.structuredContent });
    if (!res.result.isError) break;
  }
  return results;
}

const URL_PATH = "/p/tidewater/voyage-plan?harbor=mombasa"; // $0.25, payable from USDC on Base through NEAR Intents

describe.each<Failure>(["none", "settle", "upstream"])("retry-happy agent, failure injected at: %s", (failure) => {
  it("the seller receives exactly one deposit", async () => {
    inject(failure);
    const { buyer, walletDeposits } = agentBuyer();
    const results = await retryHappyAgent(buyer, `${h.base}${URL_PATH}`, 3);
    const stats = h.proxy.intents.sim!.depositStats();
    // Per-run numbers, printed so before/after runs can be compared.
    console.log(`[retry-harness] failure=${failure} attempts=${results.length} wallet_deposits=${walletDeposits()} seller_deposits=${stats.count} seller_received_usdc=${(Number(stats.totalBaseUnits) / 1e6).toFixed(6)}`);
    expect(walletDeposits()).toBe(1);
    expect(stats.count).toBe(1);
  });
});
