import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHAINS, HOME_SELLER_ID, ReceiptSigner, Store, canonicalJson, formatUnits, loadConfig, log, parseMode, parseUnits, seedStore, verifyReceipt,
} from "../src/index";

describe("money", () => {
  it("round-trips decimal strings without floats", () => {
    expect(parseUnits("0.004", 6)).toBe(4000n);
    expect(formatUnits(4000n, 6)).toBe("0.004");
    expect(formatUnits(5_000_000n, 6)).toBe("5");
    expect(() => parseUnits("0.0000001", 6)).toThrow();
    expect(() => parseUnits("1e3", 6)).toThrow();
  });
});

describe("config", () => {
  it("defaults to demo and refuses live mode without secrets", () => {
    expect(parseMode(undefined)).toBe("demo");
    expect(() => parseMode("prod")).toThrow();
    expect(loadConfig({}).mode).toBe("demo");
    expect(() => loadConfig({ MODE: "live" })).toThrow(/OPERATION_TOKEN_SECRET/);
    expect(() => loadConfig({ MODE: "dry", OPERATION_TOKEN_SECRET: "abcd" })).toThrow(/32 bytes/);
  });
});

describe("chain registry", () => {
  it("matches the recorded 1Click token list", () => {
    const tokens = JSON.parse(readFileSync(new URL("../../intents-adapter/fixtures/tokens.2026-11-01.json", import.meta.url), "utf8")) as { assetId: string; decimals: number; blockchain: string }[];
    for (const chain of CHAINS) {
      for (const asset of chain.assets) {
        const t = tokens.find((x) => x.assetId === asset.oneClickAssetId);
        expect(t, `${chain.key} ${asset.symbol}`).toBeDefined();
        expect(t!.decimals).toBe(asset.decimals);
        expect(t!.blockchain).toBe(chain.key);
      }
    }
  });
});

describe("receipts", () => {
  it("signs canonical JSON and detects tampering", () => {
    const signer = ReceiptSigner.ephemeral();
    const r = signer.sign({ b: 1, a: "x" });
    expect(verifyReceipt(r)).toBe(true);
    expect(verifyReceipt({ ...r, body: { b: 2, a: "x" } })).toBe(false);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe('{"a":[2,{"c":0,"d":1}],"b":1}');
  });
});

describe("seed", () => {
  it("writes 400+ simulated payments across chains, idempotently", () => {
    const store = new Store(":memory:");
    const sum = seedStore(store, { origin: "http://localhost:4020", upstream: "http://127.0.0.1:4030", now: 1_790_000_000_000 });
    expect(sum.payments).toBeGreaterThanOrEqual(400);
    expect(sum.probes).toBeGreaterThan(sum.payments);
    const home = store.listPayments({ sellerId: HOME_SELLER_ID, limit: 5000 });
    expect(new Set(home.map((p) => p.originChain)).size).toBeGreaterThanOrEqual(7);
    // No payment uses a route whose 1Click bridge minimum is above the amount delivered.
    for (const p of home) expect(BigInt(CHAINS.find((c) => c.key === p.originChain)!.routeMinimumUsdc)).toBeLessThanOrEqual(BigInt(p.amountOut));
    expect(home.every((p) => p.simulated)).toBe(true);
    expect(home.filter((p) => p.originTx).every((p) => p.originTx!.startsWith("sim"))).toBe(true);
    const again = seedStore(store, { origin: "http://localhost:4020", upstream: "http://127.0.0.1:4030" });
    expect(again.payments).toBe(store.countPayments());
  });
});

describe("store guarantees", () => {
  it("grants exactly one claim and one execution per operation", () => {
    const store = new Store(":memory:");
    const now = 1000;
    expect(store.claimOperation("op", "a", 5000, now).state).toBe("claimed");
    expect(store.claimOperation("op", "b", 5000, now).state).toBe("busy");
    expect(store.claimOperation("op", "b", 5000, now + 6000).state).toBe("claimed");
    expect(store.recordResult("op", "a", { ok: 1 }, now + 6001)).toBe(false);
    expect(store.recordResult("op", "b", { ok: 2 }, now + 6001)).toBe(true);
    expect(store.claimOperation("op", "c", 5000, now + 7000)).toEqual({ state: "recorded", result: { ok: 2 } });
    expect(store.markExecuted("op", now)).toBe(true);
    expect(store.markExecuted("op", now)).toBe(false);
    expect(store.firstSeen("h", now)).toBe(true);
    expect(store.firstSeen("h", now)).toBe(false);
  });
});

describe("log redaction", () => {
  it("never writes keys, JWTs or secrets, whatever the field spelling", () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    const prev = process.env.PENSTOCK_LOG;
    process.env.PENSTOCK_LOG = "info";
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => (lines.push(s), true);
    try {
      log("info", "check", {
        headers: { "x-api-key": "jwt-value-1", authorization: "Bearer jwt-value-2" },
        PAYER_SOLANA_PRIVATE_KEY: "solana-secret-3", sellerNearPrivateKey: "ed25519:near-secret-4",
        ONECLICK_JWT: "jwt-value-5", OPERATION_TOKEN_SECRET: "hmac-secret-6", ok: "visible",
      });
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
      process.env.PENSTOCK_LOG = prev;
    }
    const out = lines.join("");
    expect(out).toContain("visible");
    for (const s of ["jwt-value-1", "jwt-value-2", "solana-secret-3", "near-secret-4", "jwt-value-5", "hmac-secret-6"]) expect(out).not.toContain(s);
  });
});
