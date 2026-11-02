import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { base58Encode } from "@penstock/intents-adapter";
import { SpendCapError, assertWithinCap, readLiveEnv, solanaAddressOf } from "../src/index";

function solanaKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { secret: base58Encode(Buffer.concat([seed, pub])), address: base58Encode(pub), seed, pub };
}

describe("spend cap", () => {
  it("refuses amounts over the cap, non-positive amounts and a bad cap", () => {
    expect(() => assertWithinCap(0.25, 1)).not.toThrow();
    expect(() => assertWithinCap(1.0001, 1)).toThrow(SpendCapError);
    expect(() => assertWithinCap(0, 1)).toThrow(SpendCapError);
    expect(() => assertWithinCap(Number.NaN, 1)).toThrow(SpendCapError);
    expect(() => assertWithinCap(0.5, 0)).toThrow(SpendCapError);
  });

  it("defaults LIVE_MAX_USD to 1 when missing or malformed, never to unlimited", () => {
    expect(readLiveEnv({}).maxUsd).toBe(1);
    expect(readLiveEnv({ LIVE_MAX_USD: "abc" }).maxUsd).toBe(1);
    expect(readLiveEnv({ LIVE_MAX_USD: "-5" }).maxUsd).toBe(1);
    expect(readLiveEnv({ LIVE_MAX_USD: "0.5" }).maxUsd).toBe(0.5);
  });
});

describe("key checks reveal only public facts", () => {
  it("derives the Solana address from a 64-byte secret and rejects a mismatched one", () => {
    const k = solanaKeypair();
    expect(solanaAddressOf(k.secret)).toBe(k.address);
    const other = solanaKeypair();
    expect(solanaAddressOf(base58Encode(Buffer.concat([k.seed, other.pub])))).toBeNull();
    expect(solanaAddressOf("not-base58-0OIl")).toBeNull();
    expect(solanaAddressOf(k.address)).toBeNull();
  });
});
