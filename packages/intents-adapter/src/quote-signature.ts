/**
 * Verifies the ed25519 `signature` 1Click puts on every quote, as documented at
 * https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature
 * and implemented by `verifyQuoteSignature()` in @defuse-protocol/one-click-sdk-typescript 0.1.26:
 *
 *   message = base58(sha256(stableStringify({ ...signedRequestFields, ...signedQuoteFields, timestamp })))
 *   valid   = ed25519.verify(utf8(message), base58(signature), ONE_CLICK_MANAGER_PUB_KEY)
 *
 * The field lists below mirror the SDK exactly: fields the SDK leaves out of the signed payload are
 * left out here, and empty optional values are dropped (stable stringify skips undefined).
 * Uses only node:crypto, so the adapter keeps no third-party dependencies.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import type { QuoteResponse } from "./oneclick";

/** The 1Click manager key, from the official TypeScript SDK (0.1.26). */
export const ONE_CLICK_MANAGER_PUB_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** JSON with object keys sorted and undefined members skipped (json-stable-stringify semantics). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const parts = Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`);
  return `{${parts.join(",")}}`;
}

const orUndef = <T>(x: T): T | undefined => (x ? x : undefined);

/** The base58 SHA-256 digest 1Click signs for this quote. */
export function quoteHash(r: QuoteResponse): string {
  const q = r.quoteRequest as QuoteResponse["quoteRequest"] & Record<string, unknown>;
  const request = {
    dry: q.dry, swapType: q.swapType, slippageTolerance: q.slippageTolerance, originAsset: q.originAsset,
    depositType: q.depositType, destinationAsset: q.destinationAsset, amount: q.amount, refundTo: q.refundTo,
    refundType: q.refundType, recipient: q.recipient, recipientType: q.recipientType, deadline: q.deadline,
    quoteWaitingTimeMs: orUndef(q.quoteWaitingTimeMs), referral: orUndef(q.referral),
    virtualChainRecipient: orUndef(q.virtualChainRecipient), virtualChainRefundRecipient: orUndef(q.virtualChainRefundRecipient),
    customRecipientMsg: orUndef(q.customRecipientMsg),
  };
  const a = r.quote;
  const amounts = {
    amountIn: a.amountIn, amountInFormatted: a.amountInFormatted, amountInUsd: a.amountInUsd, minAmountIn: a.minAmountIn,
    amountOut: a.amountOut, amountOutFormatted: a.amountOutFormatted, amountOutUsd: a.amountOutUsd, minAmountOut: a.minAmountOut,
  };
  const quote = q.dry ? amounts : {
    ...amounts,
    depositAddress: orUndef(a.depositAddress), depositMemo: orUndef(a.depositMemo), deadline: orUndef(a.deadline),
    timeWhenInactive: orUndef(a.timeWhenInactive), timeEstimate: orUndef(a.timeEstimate), refundFee: orUndef(a.refundFee),
    withdrawFee: orUndef(a.withdrawFee),
  };
  const digest = createHash("sha256").update(stableStringify({ ...request, ...quote, timestamp: r.timestamp }), "utf8").digest();
  return base58Encode(digest);
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeKey(v: string): Uint8Array {
  return base58Decode(v.startsWith("ed25519:") ? v.slice("ed25519:".length) : v);
}

/** True when the quote carries a valid 1Click signature. Never throws. */
export function verifyQuoteSignature(r: QuoteResponse, managerPublicKey = ONE_CLICK_MANAGER_PUB_KEY): boolean {
  try {
    const raw = decodeKey(managerPublicKey);
    const sig = decodeKey(r.signature);
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(quoteHash(r), "utf8"), key, sig);
  } catch {
    return false;
  }
}
