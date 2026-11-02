import { describe, expect, it } from "vitest";
import { HOME_SELLER_ID, Store, loadConfig } from "@penstock/core";
import { SimulatedOneClick } from "@penstock/intents-adapter";
import { createProxy } from "../src/index";
import { discoveryDocument } from "../src/discovery";

describe("live mode startup", () => {
  it("starts without a facilitator, offering near-intents only, with one real seller and no simulated history", () => {
    // Test secrets only; nothing here touches the network or listens on a port.
    const config = loadConfig({
      MODE: "live", PORT: "4999", PUBLIC_URL: "http://127.0.0.1:4999", SELLER_NEAR_ACCOUNT: "acedevv.near",
      OPERATION_TOKEN_SECRET: "a".repeat(64), ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
    });
    const proxy = createProxy({ config, store: new Store(":memory:"), oneClick: new SimulatedOneClick() });
    expect(proxy.store.getSeller(HOME_SELLER_ID)).toMatchObject({ nearAccount: "acedevv.near", simulated: false });
    expect(proxy.store.countPayments()).toBe(0);
    expect(proxy.ctx.methods.map((m) => m.id)).toEqual(["near-intents"]);
    const doc = discoveryDocument(proxy.ctx) as unknown as { paymentMethods: { id: string }[]; simulated: boolean };
    expect(doc.paymentMethods.map((m) => m.id)).toEqual(["near-intents"]);
    expect(doc.simulated).toBe(false);
  });
});
