import { describe, expect, it } from "vitest";
import { money, moneyExact, moneyUsd } from "../src/format";

describe("money", () => {
  it("formats totals with exactly two decimals and grouping", () => {
    expect(money("0")).toBe("$0.00");
    expect(money("1234500000")).toBe("$1,234.50");
    expect(money("4000")).toBe("$0.00");
    expect(money("5000")).toBe("$0.01");
    expect(money(-2_500_000n)).toBe("-$2.50");
  });

  it("formats per-call amounts with two to four decimals", () => {
    expect(money("4000", "micro")).toBe("$0.004");
    expect(money("12500", "micro")).toBe("$0.0125");
    expect(money("2000000", "micro")).toBe("$2.00");
    expect(money("123456", "micro")).toBe("$0.1235");
    expect(money("50", "micro")).toBe("<$0.0001");
    expect(money("0", "micro")).toBe("$0.00");
  });

  it("gives the exact value for tooltips", () => {
    expect(moneyExact("4000")).toBe("0.004000 USDC");
    expect(moneyExact("1234500000")).toBe("1234.500000 USDC");
  });

  it("converts float dollars", () => {
    expect(moneyUsd(0.0042, "micro")).toBe("$0.0042");
    expect(moneyUsd(12.345)).toBe("$12.35");
  });
});
