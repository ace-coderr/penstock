import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSnapshot } from "../../console/scripts/snapshot";
import { endpointsView, exportCsv, funnel, listPayments, overview, sessionsView } from "../../console/src/static/compute";
import type { Snapshot } from "../../console/src/static/snapshot";
import { startHarness, type Harness } from "./helpers";

/**
 * The hosted static demo answers the console's API calls in the browser. Its responses must have
 * the same shapes and values as the real proxy's for the same ledger.
 */
const NOW = Date.now();
let h: Harness;
let snap: Snapshot;
beforeAll(async () => {
  h = await startHarness({}, { now: () => NOW });
  snap = buildSnapshot(h.proxy.store, { origin: h.base, now: NOW });
});
afterAll(() => h.stop());

const real = async <T>(path: string) => (await (await fetch(`${h.base}/api/admin${path}`)).json()) as T;

describe("hosted demo API parity with the real admin API", () => {
  it("overview", async () => {
    const r = await real<Record<string, unknown>>("/overview?days=30");
    const s = overview(snap, NOW, 30) as unknown as Record<string, unknown>;
    for (const k of Object.keys(s)) expect(s[k], k).toEqual(r[k]);
  });

  it("payments list and filters", async () => {
    for (const qs of ["?limit=50", "?status=refunded&limit=50", "?chain=sol&limit=20", "?limit=25&offset=25"]) {
      const r = await real<{ total: number; payments: { id: string }[] }>(`/payments${qs}`);
      const p = new URLSearchParams(qs);
      const s = listPayments(snap, { status: p.get("status") ?? undefined, chain: p.get("chain") ?? undefined, limit: Number(p.get("limit")), offset: Number(p.get("offset") ?? 0) });
      expect(s.total, qs).toBe(r.total);
      expect(s.payments.map((x) => x.id), qs).toEqual(r.payments.map((x) => x.id));
      expect(JSON.parse(JSON.stringify(s.payments))).toEqual(r.payments);
    }
  });

  it("funnel", async () => {
    const r = await real<ReturnType<typeof funnel>>("/funnel?days=30");
    const s = funnel(snap, NOW, 30);
    expect(s.stages).toEqual(r.stages);
    expect(s.byEndpoint).toEqual(r.byEndpoint);
    expect(s.buyers).toBe(r.buyers);
    expect(s.note).toBe(r.note);
    const key = (x: { reason: string; stage: string; count: number }) => `${x.stage}|${x.reason}|${x.count}`;
    expect(s.inferredReasons.map(key).sort()).toEqual(r.inferredReasons.map(key).sort());
    expect(Object.keys(s.recent[0]!).sort()).toEqual(Object.keys(r.recent[0]!).sort());
  });

  it("endpoints and sessions", async () => {
    expect(endpointsView(snap, NOW, 30)).toEqual(await real("/endpoints?days=30"));
    const r = await real<ReturnType<typeof sessionsView>>("/sessions");
    const s = sessionsView(snap);
    expect(s.capUsdc).toBe(r.capUsdc);
    expect(JSON.parse(JSON.stringify(s.sessions))).toEqual(r.sessions);
  });

  it("accountant CSV", async () => {
    const r = await (await fetch(`${h.base}/api/admin/export.csv?days=30`)).text();
    expect(exportCsv(snap, NOW - 30 * 86_400_000, NOW)).toBe(r);
  });

  it("carries no secrets: receipts hold a public key and signature only", () => {
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/PRIVATE KEY|secretHash|secret_hash|operationToken/i);
    const r = Object.values(snap.receipts)[0]!;
    expect(Object.keys(r).sort()).toEqual(["body", "pub", "sig"]);
  });
});
