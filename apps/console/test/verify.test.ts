import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { ReceiptSigner, canonicalJson as coreCanonical, verifyReceipt as coreVerify } from "@penstock/core";
import { canonicalJson, parseReceipt, verifyReceipt } from "../src/verify";

const subtle = webcrypto.subtle as unknown as SubtleCrypto;
const proof = JSON.parse(readFileSync(new URL("../../../docs/proof.json", import.meta.url), "utf8"));
const real = proof.entries.find((e: { kind: string }) => e.kind === "payment").receipt;

describe("browser receipt verification matches @penstock/core", () => {
  it("accepts the real mainnet receipt", async () => {
    expect(coreVerify(real)).toBe(true);
    expect(await verifyReceipt(real, subtle)).toEqual({ valid: true });
  });

  it("rejects a changed body, a wrong key and a broken signature, like core does", async () => {
    const changed = { ...real, body: { ...real.body, amountUsdc: "10001" } };
    const other = ReceiptSigner.ephemeral().sign({ v: 1 });
    const wrongKey = { ...real, pub: other.pub };
    const broken = { ...real, sig: real.sig.slice(0, -4) + "AAAA" };
    for (const r of [changed, wrongKey, broken]) {
      expect(coreVerify(r)).toBe(false);
      expect((await verifyReceipt(r, subtle)).valid).toBe(false);
    }
  });

  it("verifies fresh receipts signed by core, including key order and undefined members", async () => {
    const s = ReceiptSigner.ephemeral();
    for (const body of [{ b: 2, a: 1 }, { z: { y: [3, { x: undefined, w: "é" }] }, a: null }, { v: 1, simulated: false, amountUsdc: "4000" }]) {
      const r = s.sign(body);
      expect(canonicalJson(body)).toBe(coreCanonical(body));
      expect(await verifyReceipt(r as never, subtle)).toEqual({ valid: true });
    }
  });

  it("parses a receipt pasted as JSON or as a PENSTOCK-RECEIPT header value", () => {
    const header = Buffer.from(JSON.stringify(real)).toString("base64url");
    expect(parseReceipt(JSON.stringify(real))).toEqual(real);
    expect(parseReceipt(header)).toEqual(real);
    expect(parseReceipt(`PENSTOCK-RECEIPT: ${header}`)).toEqual(real);
    expect(parseReceipt("not a receipt")).toBeNull();
    expect(parseReceipt('{"body":1}')).toBeNull();
  });
});
