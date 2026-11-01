import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatReport, runSelftest } from "@penstock/selftest";
import { startHarness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.stop());

describe("pnpm selftest", () => {
  it("passes against a demo proxy, paying end to end with simulated wallets", async () => {
    const r = await runSelftest({ url: `${h.base}/p/tidewater/tides?harbor=lagos` });
    expect(r.mode).toBe("simulated");
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.pass).toBe(true);
    expect(formatReport(r, "x")).toMatch(/PASS$/);
  });

  it("fails with a reason when the URL is not paywalled or not reachable", async () => {
    const open = await runSelftest({ url: `${h.base}/healthz` });
    expect(open.pass).toBe(false);
    expect(open.checks[0]!.detail).toMatch(/not paywalled/);
    const down = await runSelftest({ url: "http://127.0.0.1:9/x" });
    expect(down.checks[0]!.detail).toMatch(/request failed/);
  });
});
