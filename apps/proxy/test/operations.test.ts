import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDepositPayload, buildQuotePayload, depositInstructions, findQuotedEntry, isUnquoted, SimulatedOneClick, type DepositInstructions } from "@penstock/intents-adapter";
import type { PaymentRequired, PaymentRequirements } from "@penstock/core";
import { get402, paidInit, startHarness, type Harness } from "./helpers";

let h: Harness;
let sim: SimulatedOneClick;
let clock: number;
beforeEach(async () => {
  sim = new SimulatedOneClick({ processingMs: 40 });
  clock = Date.now();
  h = await startHarness({}, { oneClick: sim, now: () => clock });
});
afterEach(() => h.stop());

const URL_ = () => `${h.base}/p/tidewater/voyage-plan?harbor=mombasa`;
const REFUND_A = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const REFUND_B = "0x1111111111111111111111111111111111111111";

async function quote(refundTo = REFUND_A, ua = "agent-a"): Promise<{ required: PaymentRequired; unquoted: PaymentRequirements; ins: DepositInstructions }> {
  const { required } = await get402(URL_(), { headers: { "user-agent": ua } });
  const unquoted = required.accepts.find((a) => isUnquoted(a) && a.network.startsWith("eip155:8453"))!;
  const r = await fetch(URL_(), paidInit(buildQuotePayload(required, unquoted, refundTo), { headers: { "user-agent": ua } }));
  const second = (await r.json()) as PaymentRequired;
  return { required, unquoted, ins: depositInstructions(findQuotedEntry(second, unquoted)!) };
}

async function lookup(token: unknown) {
  const r = await fetch(`${h.base}/api/public/operation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationToken: token }) });
  return { status: r.status, op: ((await r.json()) as { operation: Record<string, unknown> }).operation };
}

async function settle(q: Awaited<ReturnType<typeof quote>>, ua = "agent-a") {
  const tx = sim.deposit(q.ins.payTo, q.ins.amount);
  return fetch(URL_(), paidInit(buildDepositPayload(q.required, q.unquoted, q.ins, tx), { headers: { "user-agent": ua } }));
}

describe("server-side quote idempotency", () => {
  it("returns the same quote and deposit address to the same buyer for the same purchase", async () => {
    const a = await quote();
    const b = await quote();
    expect(b.ins).toEqual(a.ins);
    expect(sim.depositStats().addresses).toBe(0);
  });

  it("a different refund address, a different buyer, or a changed resource gets its own quote", async () => {
    const a = await quote();
    expect((await quote(REFUND_B)).ins.payTo).not.toBe(a.ins.payTo);
    expect((await quote(REFUND_A, "agent-b")).ins.payTo).not.toBe(a.ins.payTo);
  });

  it("an expired quote is not reused; a settled one is never handed out again (addresses are single-use)", async () => {
    const a = await quote();
    clock += 20 * 60_000;
    expect((await quote()).ins.payTo).not.toBe(a.ins.payTo);
    const b = await quote("0x2222222222222222222222222222222222222222");
    const res = await settle(b);
    expect(res.status).toBe(200);
    const c = await quote("0x2222222222222222222222222222222222222222");
    expect(c.ins.payTo).not.toBe(b.ins.payTo);
  });
});

describe("operation lookup by token", () => {
  it("follows one operation: quoted, then deposit in progress once 1Click sees it", async () => {
    const q = await quote();
    expect((await lookup(q.ins.operationToken)).op.state).toBe("quoted");
    sim.deposit(q.ins.payTo, q.ins.amount);
    expect((await lookup(q.ins.operationToken)).op.state).toBe("deposit_in_progress");
  });

  it("reports delivered with payment_id and receipt, and upstream failure as upstream_failed", async () => {
    const q = await quote();
    const res = await settle(q);
    expect(res.status).toBe(200);
    const v = await lookup(q.ins.operationToken);
    expect(v.op.state).toBe("delivered");
    expect(v.op.payment_id).toMatch(/^pay_/);
    expect((v.op.receipt as { body: { paymentId: string } }).body.paymentId).toBe(v.op.payment_id);

    const real = h.proxy.ctx.delivery;
    h.proxy.ctx.delivery = { ...real, async deliver() { throw new Error("down"); } };
    const q2 = await quote("0x3333333333333333333333333333333333333333");
    expect((await settle(q2)).status).toBe(502);
    expect((await lookup(q2.ins.operationToken)).op.state).toBe("upstream_failed");
  });

  it("gives nothing away for a wrong, altered or foreign token, and never shows other buyers' data", async () => {
    const q = await quote();
    const other = await quote(REFUND_B, "agent-b");
    await settle(other, "agent-b");
    const bad = [null, 42, "", "k1.1.AAAA", q.ins.operationToken.slice(0, -2) + "xx", "x".repeat(400)];
    for (const t of bad) expect((await lookup(t)).op).toEqual({ state: "unknown" });
    const mine = (await lookup(q.ins.operationToken)).op;
    expect(Object.keys(mine).sort()).toEqual(["state"]);
    // A holder sees its own operation (including its own payer address) and nothing of anyone else's.
    const mineText = JSON.stringify(mine);
    for (const theirs of [REFUND_B, other.ins.payTo, "agent-b"]) expect(mineText).not.toContain(theirs);
    expect(JSON.stringify((await lookup(other.ins.operationToken)).op)).not.toContain(q.ins.payTo);
  });
});
