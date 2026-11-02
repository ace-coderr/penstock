import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { abandonRefusal, planRefusal, redactSpent, sendRefusal, type GuardState } from "../src/index";

const NOW = Date.parse("2026-11-02T22:00:00Z");
const state = (status: GuardState["status"], deadlineMs = NOW + 300_000): GuardState => ({ status, deposit: { payTo: "DepositAddr111", refundDeadline: new Date(deadlineMs).toISOString() }, txHash: status === "planned" ? undefined : "sig1" });

describe("double-send protection", () => {
  it("sends only a planned payment, to the confirmed address, with time left on the quote", () => {
    expect(sendRefusal(state("planned"), "DepositAddr111", NOW)).toBeNull();
    expect(sendRefusal(null, "DepositAddr111", NOW)).toMatch(/no planned payment/);
    expect(sendRefusal(state("planned"), "OtherAddr", NOW)).toMatch(/--confirm/);
    expect(sendRefusal(state("planned", NOW + 60_000), "DepositAddr111", NOW)).toMatch(/expires/);
    for (const s of ["sending", "sent", "paid", "refunded", "failed", "abandoned"] as const) {
      expect(sendRefusal(state(s), "DepositAddr111", NOW), s).toMatch(/at most once/);
    }
  });

  it("will not plan over a payment in flight", () => {
    expect(planRefusal(state("sending"))).toMatch(/resume/);
    expect(planRefusal(state("sent"))).toMatch(/resume/);
    expect(planRefusal(state("paid"))).toBeNull();
    expect(planRefusal(null)).toBeNull();
  });

  it("abandons only after the deadline and only if the transaction is not on chain", () => {
    const sent = state("sent", NOW - 300_000);
    expect(abandonRefusal(sent, false, NOW)).toBeNull();
    expect(abandonRefusal(sent, true, NOW)).toMatch(/on chain/);
    expect(abandonRefusal(state("sent", NOW), false, NOW)).toMatch(/wait/);
    expect(abandonRefusal(state("paid"), false, NOW)).toMatch(/nothing in flight/);
  });

  it("drops the spent operation token from records", () => {
    const r = redactSpent({ status: "paid", deposit: { payTo: "x", operationToken: "k1.123.mac" } });
    expect(JSON.stringify(r)).not.toContain("k1.123.mac");
  });
});

describe("the payer key stays out of output and files", () => {
  it("no live script prints, logs or writes PAYER_SOLANA_PRIVATE_KEY or env.payerSecret", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      for (const line of src.split("\n")) {
        if (/console\.|writeFileSync|save\(|die\(|JSON\.stringify/.test(line)) {
          expect(line, `${f}: ${line.trim()}`).not.toMatch(/payerSecret(?!\))|env\.PAYER_SOLANA_PRIVATE_KEY/);
        }
      }
    }
  });
});
