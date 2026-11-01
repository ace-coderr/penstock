import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { loadConfig, Store } from "@penstock/core";
import { createProxy } from "../src/index";

describe("proxy", () => {
  it("reports demo mode and what is simulated", async () => {
    const { server } = createProxy({ config: loadConfig({ MODE: "demo" }), store: new Store(":memory:") });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const body = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { mode: string; simulation: { settlement: boolean } };
    expect(body.mode).toBe("demo");
    expect(body.simulation.settlement).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
