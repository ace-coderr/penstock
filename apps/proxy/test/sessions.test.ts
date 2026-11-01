import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyReceipt, type PaymentRequired } from "@penstock/core";
import { buildExactPayload, isExactNear, simulatedNearWallet } from "@penstock/buyer-mcp";
import { get402, paidInit, startHarness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.stop());

interface Opened {
  session: { id: string; token: string; calls: number; fundedUsdc: string; refundTo: string };
  receipt: { body: Record<string, unknown>; sig: string; pub: string };
  simulated: boolean;
}

async function openSession(amount: string, slug = "tides", query = ""): Promise<Opened> {
  const url = `${h.base}/s/tidewater/${slug}/open/${amount}${query}`;
  const { required } = await get402(url);
  expect(required.resource.url).toBe(`${h.base}/s/tidewater/${slug}/open/${amount}`);
  const offer = required.accepts.find(isExactNear)!;
  expect(offer.amount).toBe(amount);
  const payload = await buildExactPayload(simulatedNearWallet("session-buyer.near"), required, offer);
  const res = await fetch(url, paidInit(payload));
  expect(res.status).toBe(200);
  return (await res.json()) as Opened;
}

const closeSession = (token: string) => fetch(`${h.base}/s/tidewater/tides/close`, { method: "POST", headers: { "PENSTOCK-SESSION": token } });
const call = (token: string, slug = "tides") => fetch(`${h.base}/p/tidewater/${slug}?harbor=halifax`, { headers: { "PENSTOCK-SESSION": token } });

describe("prepaid sessions", () => {
  it("enforces the hard cap and a one-call minimum", async () => {
    expect((await fetch(`${h.base}/s/tidewater/tides/open/6000000`)).status).toBe(400);
    expect((await fetch(`${h.base}/s/tidewater/tides/open/100`)).status).toBe(400);
    expect((await fetch(`${h.base}/s/tidewater/summarize/open/1000000`)).status).toBe(404); // sessions not enabled there
  });

  it("opens with one payment, meters calls, and stops at the funded balance", async () => {
    const o = await openSession("20000"); // 5 calls at $0.004
    expect(o.session.calls).toBe(5);
    expect(verifyReceipt(o.receipt)).toBe(true);
    expect(o.receipt.body).toMatchObject({ kind: "session", status: "open", fundedUsdc: "20000", capUsdc: "5000000", simulated: true });
    for (let i = 0; i < 5; i++) {
      const r = await call(o.session.token);
      expect(r.status).toBe(200);
      expect(r.headers.get("penstock-session-balance")).toContain(`remaining=${20000 - (i + 1) * 4000}`);
    }
    const sixth = await call(o.session.token);
    expect(sixth.status).toBe(402);
    expect(((await sixth.json()) as { error: string }).error).toMatch(/exhausted/);
    // The funding payment is in the books, tagged with the session.
    const s = h.proxy.store.getSession(o.session.id)!;
    expect(h.proxy.store.getPayment(s.fundingPaymentId)).toMatchObject({ sessionId: o.session.id, amountOut: "20000", status: "settled" });
    await closeSession(o.session.token);
  });

  it("never overspends under concurrent calls", async () => {
    const o = await openSession("20000");
    const results = await Promise.all(Array.from({ length: 12 }, () => call(o.session.token).then((r) => r.status)));
    expect(results.filter((s) => s === 200)).toHaveLength(5);
    expect(h.proxy.store.getSession(o.session.id)!.spentUsdc).toBe("20000");
    await closeSession(o.session.token);
  });

  it("settles spend in batches and refunds the unused balance on close, with a signed receipt", async () => {
    const o = await openSession("2000000", "tides", "?refundTo=refund-me.near");
    for (let i = 0; i < 30; i++) expect((await call(o.session.token)).status).toBe(200);
    expect(BigInt(h.proxy.store.getSession(o.session.id)!.settledUsdc)).toBeGreaterThanOrEqual(25n * 4000n);

    const status = await fetch(`${h.base}/s/tidewater/tides/status`, { headers: { "PENSTOCK-SESSION": o.session.token } });
    const st = (await status.json()) as Opened;
    expect(verifyReceipt(st.receipt)).toBe(true);
    expect(st.receipt.body).toMatchObject({ calls: 30, spentUsdc: "120000" });

    const closed = await fetch(`${h.base}/s/tidewater/tides/close`, { method: "POST", headers: { "PENSTOCK-SESSION": o.session.token } });
    const c = (await closed.json()) as Opened;
    expect(verifyReceipt(c.receipt)).toBe(true);
    expect(c.receipt.body).toMatchObject({ status: "closed", spentUsdc: "120000", settledUsdc: "120000", refundUsdc: "1880000", refundTo: "refund-me.near", refundState: "simulated" });
    expect(String(c.receipt.body.refundTx)).toMatch(/^sim:/);

    // Closing twice does not refund twice; calls after close are refused.
    const again = (await (await fetch(`${h.base}/s/tidewater/tides/close`, { method: "POST", headers: { "PENSTOCK-SESSION": o.session.token } })).json()) as Opened;
    expect(again.receipt.body.refundUsdc).toBe("1880000");
    expect((await call(o.session.token)).status).toBe(410);
  });

  it("rejects forged tokens and tokens used on another endpoint", async () => {
    const o = await openSession("20000");
    const forged = o.session.token.slice(0, -3) + "AAA";
    expect((await call(forged)).status).toBe(401);
    expect((await call("ses_0000000000000000.xyz")).status).toBe(401);
    const other = await fetch(`${h.base}/p/tidewater/geocode?q=lagos`, { headers: { "PENSTOCK-SESSION": o.session.token } });
    expect(other.status).toBe(403);
    await closeSession(o.session.token);
  });

  it("limits how many sessions one buyer can hold open on an endpoint", async () => {
    const opened = [await openSession("20000"), await openSession("20000"), await openSession("20000")];
    const url = `${h.base}/s/tidewater/tides/open/20000`;
    const { required } = await get402(url);
    const payload = await buildExactPayload(simulatedNearWallet(), required, required.accepts.find(isExactNear)!);
    expect((await fetch(url, paidInit(payload))).status).toBe(429);
    for (const o of opened) await closeSession(o.session.token);
  });

  it("closes expired sessions in the sweeper and refunds them", async () => {
    const o = await openSession("20000");
    expect((await call(o.session.token)).status).toBe(200);
    h.proxy.store.setSessionExpiry(o.session.id, Date.now() - 1);
    h.proxy.sessions.sweep();
    expect(h.proxy.store.getSession(o.session.id)).toMatchObject({ status: "closed", refundUsdc: "16000", refundState: "simulated" });
  });

  it("returns 402 with session terms before payment", async () => {
    const r = await fetch(`${h.base}/s/tidewater/tides/open/1000000`);
    const body = (await r.json()) as PaymentRequired;
    expect(r.status).toBe(402);
    expect(body.resource.description).toMatch(/250 calls/);
  });
});
