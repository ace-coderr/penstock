import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { describeOperation, type Operation } from "../src/index";

/**
 * The on-call samples in docs/RETRY-TEST.md must say exactly what the code says for the same state and id,
 * so the runbook cannot drift from envelope.ts.
 */
const doc = readFileSync(new URL("../../../docs/RETRY-TEST.md", import.meta.url), "utf8");
const samples = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!) as { state: string; money_moved: string; do_not_retry: boolean; operation_id: string; payment_id: string | null; next_action: string });

const base = (over: Partial<Operation>): Operation => ({
  id: "", key: "k", buyer: "b", method: "near-intents", url: "http://x", paramsHash: "h", request: { method: "GET", headers: {}, body: null }, state: "quoted", createdAt: 0, updatedAt: 1,
  amountUsdc: "250000", feeUsdc: "0", debitedUsdc: "250000", debited: null, paymentId: null, originChain: "base", originSymbol: "USDC", quote: null, exactPayload: null, txHash: null,
  manualDeposit: false, receipt: null, settlement: null, resultBody: null, resultStatus: null, acknowledged: false, statusViewed: false, refundState: "none", refundAmountUsdc: null, lastError: null, note: null, ...over,
});

describe("the on-call samples in RETRY-TEST.md", () => {
  it("there are two samples, with the documented fields", () => {
    expect(samples.map((s) => s.state)).toEqual(["confirming", "upstream_failed_after_settlement"]);
    for (const s of samples) expect(Object.keys(s).sort()).toEqual(["do_not_retry", "money_moved", "next_action", "operation_id", "payment_id", "state"]);
  });

  it("each sample equals what describeOperation produces for the same state and id", () => {
    for (const s of samples) {
      const tx = /\(tx ([^)]+)\)/.exec(s.next_action)?.[1] ?? null;
      const op = base({ id: s.operation_id, state: s.state as Operation["state"], txHash: tx, resultStatus: s.state === "upstream_failed_after_settlement" ? 502 : null });
      const d = describeOperation(op);
      expect(d.next_action, s.state).toBe(s.next_action);
      expect(d.do_not_retry).toBe(s.do_not_retry);
      expect(s.next_action.startsWith(`Operation ${s.operation_id}: `)).toBe(true);
      expect(s.do_not_retry).toBe(true);
      expect(s.money_moved).toBe("yes");
    }
  });

  it("is demo-only: simulated hashes, demo ids, no keys or personal data in the document", () => {
    expect(doc).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|BEGIN [A-Z ]*PRIVATE|@gmail|eyJ[A-Za-z0-9_-]{20,}/);
    for (const s of samples) expect(s.operation_id).toMatch(/^op_[0-9a-f]{16}$/);
    expect(samples[0]!.next_action).toMatch(/tx sim:0x/);
    expect(doc).toMatch(/hashes with `sim`/);
  });
});
