import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

describe("recorded 1Click fixtures", () => {
  it("dry EXACT_OUTPUT quote has the documented required fields and no deposit address", () => {
    const q = fx("quote-dry-exact-output-arb-usdc.json");
    for (const k of ["correlationId", "timestamp", "signature", "quoteRequest", "quote"]) expect(q).toHaveProperty(k);
    for (const k of ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut", "timeEstimate"]) expect(q.quote).toHaveProperty(k);
    expect(q.quote.depositAddress).toBeUndefined();
    expect(q.quoteRequest.swapType).toBe("EXACT_OUTPUT");
  });
});
