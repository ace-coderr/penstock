import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { verifyReceipt } from "@penstock/core";

/**
 * docs/proof.json (served as /proof.json) must say exactly what docs/PROOF.md says: the same
 * transactions, the same amounts and the same signed receipt, and nothing simulated.
 */
const md = readFileSync(new URL("../../../docs/PROOF.md", import.meta.url), "utf8");
const proof = JSON.parse(readFileSync(new URL("../../../docs/proof.json", import.meta.url), "utf8")) as {
  simulated: boolean;
  entries: { kind: string; steps: { chain: string; hash: string; url: string; at: string }[]; receipt?: { body: Record<string, unknown>; sig: string; pub: string }; [k: string]: unknown }[];
};

const mdHashes = new Set([...md.matchAll(/\((?:https:\/\/solscan\.io\/tx|https:\/\/nearblocks\.io\/txns)\/([1-9A-HJ-NP-Za-km-z]{32,100})\)/g)].map((m) => m[1]!));

describe("proof.json matches PROOF.md", () => {
  it("lists exactly the transactions PROOF.md links to, with matching explorer URLs", () => {
    const hashes = proof.entries.flatMap((e) => e.steps.map((s) => s.hash));
    expect(new Set(hashes)).toEqual(mdHashes);
    for (const e of proof.entries) {
      for (const s of e.steps) {
        expect(s.url, s.hash).toBe(s.chain === "solana" ? `https://solscan.io/tx/${s.hash}` : `https://nearblocks.io/txns/${s.hash}`);
        expect(md, s.hash).toContain(s.url);
        // Times agree to the minute (PROOF.md shows HH:MM:SS UTC; NEAR block times carry milliseconds).
        expect(md, `${s.hash} at ${s.at}`).toContain(s.at.slice(11, 19));
      }
    }
  });

  it("every amount in proof.json appears in PROOF.md", () => {
    const amounts = proof.entries.flatMap((e) => Object.entries(e).filter(([k, v]) => k.endsWith("Usdc") && typeof v === "string").map(([k, v]) => [`${e.kind}.${k}`, v as string]));
    expect(amounts.length).toBeGreaterThanOrEqual(10);
    for (const [k, v] of amounts) expect(md, `${k} = ${v}`).toContain(v);
  });

  it("carries the same signed receipt, which verifies, and nothing is simulated", () => {
    expect(proof.simulated).toBe(false);
    const payment = proof.entries.find((e) => e.kind === "payment")!;
    const block = /```json\n([\s\S]*?)\n```/.exec(md)![1]!;
    expect(payment.receipt).toEqual(JSON.parse(block));
    expect(verifyReceipt(payment.receipt as never)).toBe(true);
    expect(payment.receipt!.body.simulated).toBe(false);
  });
});
