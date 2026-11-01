import { describe, expect, it } from "vitest";
import { loadConfig, Store } from "@penstock/core";
import { createProxy } from "../src/index";
import { listen, close, startHarness } from "./helpers";

describe("landing page stats", () => {
  it("publishes headline numbers from simulated demo data, flagged simulated", async () => {
    const h = await startHarness();
    try {
      const s = (await (await fetch(`${h.base}/api/public/stats`)).json()) as { simulated: boolean; payments: number; chains: number; receivedUsdc: string };
      expect(s.simulated).toBe(true);
      expect(s.payments).toBeGreaterThanOrEqual(400);
      expect(s.chains).toBeGreaterThanOrEqual(7);
      expect(BigInt(s.receivedUsdc)).toBeGreaterThan(0n);
    } finally {
      await h.stop();
    }
  });

  it("does not publish a live seller's numbers", async () => {
    const config = loadConfig({ MODE: "live", OPERATION_TOKEN_SECRET: "ab".repeat(32), ADMIN_TOKEN: "x".repeat(32), SELLER_NEAR_ACCOUNT: "s.near", FACILITATOR_URL: "https://facilitator.example" });
    const p = createProxy({ config, store: new Store(":memory:") });
    const base = await listen(p.server);
    try {
      expect((await fetch(`${base}/api/public/stats`)).status).toBe(404);
    } finally {
      await close(p.server);
    }
  });
});
