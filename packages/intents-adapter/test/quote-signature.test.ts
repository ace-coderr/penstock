import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { HttpOneClick, OneClickError, base58Decode, base58Encode, quoteHash, stableStringify, verifyQuoteSignature, type QuoteResponse } from "../src/index";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as QuoteResponse;

describe("1Click quote signatures", () => {
  it("verifies real recorded quotes and rejects altered ones", () => {
    for (const name of ["quote-dry-exact-output-arb-usdc.json", "quote-dry-exact-output-sol.json"]) {
      const q = fx(name);
      expect(verifyQuoteSignature(q), name).toBe(true);
      expect(verifyQuoteSignature({ ...q, quote: { ...q.quote, amountOut: String(BigInt(q.quote.amountOut) + 1n) } }), name).toBe(false);
      expect(verifyQuoteSignature({ ...q, quoteRequest: { ...q.quoteRequest, recipient: "attacker.near" } }), name).toBe(false);
      expect(verifyQuoteSignature({ ...q, signature: "ed25519:garbage" }), name).toBe(false);
    }
  });

  it("covers the deposit address on non-dry quotes", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const base = fx("quote-dry-exact-output-sol.json");
    const q: QuoteResponse = { ...base, quoteRequest: { ...base.quoteRequest, dry: false }, quote: { ...base.quote, depositAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", deadline: "2026-11-02T20:00:00.000Z" } };
    const signed = { ...q, signature: `ed25519:${base58Encode(sign(null, Buffer.from(quoteHash(q)), privateKey))}` };
    const key = `ed25519:${base58Encode(raw)}`;
    expect(verifyQuoteSignature(signed, key)).toBe(true);
    expect(verifyQuoteSignature({ ...signed, quote: { ...signed.quote, depositAddress: "AttackerAddress11111111111111111111111111111" } }, key)).toBe(false);
  });

  it("encodes like json-stable-stringify and base58", () => {
    expect(stableStringify({ b: 1, a: [2, { d: undefined, c: "x" }], u: undefined })).toBe('{"a":[2,{"c":"x"}],"b":1}');
    const bytes = Uint8Array.from([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it("the HTTP client refuses a quote whose signature does not verify", async () => {
    const q = fx("quote-dry-exact-output-arb-usdc.json");
    const body = JSON.stringify({ ...q, quote: { ...q.quote, amountOut: "999999999" } });
    const f = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const oc = new HttpOneClick({ baseUrl: "https://1click.example", fetchImpl: f });
    await expect(oc.quote(q.quoteRequest)).rejects.toThrow(OneClickError);
    await expect(oc.quote(q.quoteRequest)).rejects.toThrow(/signature/);
  });
});
