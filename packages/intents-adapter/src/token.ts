import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * `operationToken = <keyId>.<expiry>.<mac>` from the near-intents draft (section "Operation Token"):
 * mac = unpadded base64url HMAC-SHA256(key, network:depositAddress[:depositMemo]:resource:destinationHash:expiry)
 * destinationHash = lowercase hex SHA-256 of network:asset:amount:recipient.
 * Stateless: the facilitator recomputes the MAC at settlement.
 */

export interface Destination {
  network: string;
  asset: string;
  amount: string;
  recipient: string;
}

export interface TokenInput {
  network: string;
  depositAddress: string;
  depositMemo?: string;
  resource: string;
  destination: Destination;
}

export interface KeyRing {
  currentKeyId: string;
  keys: Map<string, Buffer>;
}

export function destinationHash(d: Destination): string {
  return createHash("sha256").update(`${d.network}:${d.asset}:${d.amount}:${d.recipient}`).digest("hex");
}

function macInput(t: TokenInput, expiry: number): string {
  const memo = t.depositMemo ? `:${t.depositMemo}` : "";
  return `${t.network}:${t.depositAddress}${memo}:${t.resource}:${destinationHash(t.destination)}:${expiry}`;
}

export function mintOperationToken(ring: KeyRing, input: TokenInput, expiry: number): string {
  const key = ring.keys.get(ring.currentKeyId);
  if (!key) throw new Error("current operation-token key is missing");
  if (ring.currentKeyId.includes(".")) throw new Error("keyId must not contain '.'");
  const mac = createHmac("sha256", key).update(macInput(input, expiry)).digest("base64url");
  return `${ring.currentKeyId}.${expiry}.${mac}`;
}

export type TokenCheck = { ok: true; expiry: number } | { ok: false; reason: "invalid_exact_near_intents_token_invalid" | "invalid_exact_near_intents_token_expired" };

/** Expiry is checked first, without any lookup, as the draft requires. */
export function verifyOperationToken(ring: KeyRing, token: unknown, input: TokenInput, nowSec: number): TokenCheck {
  if (typeof token !== "string" || token.length > 256) return { ok: false, reason: "invalid_exact_near_intents_token_invalid" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid_exact_near_intents_token_invalid" };
  const [keyId, expiryRaw, mac] = parts as [string, string, string];
  if (!/^\d{1,12}$/.test(expiryRaw)) return { ok: false, reason: "invalid_exact_near_intents_token_invalid" };
  const expiry = Number(expiryRaw);
  if (expiry < nowSec) return { ok: false, reason: "invalid_exact_near_intents_token_expired" };
  const key = ring.keys.get(keyId);
  if (!key) return { ok: false, reason: "invalid_exact_near_intents_token_invalid" };
  // Compare the encoded strings so non-canonical base64url spellings of the same bytes are refused.
  const expected = Buffer.from(createHmac("sha256", key).update(macInput(input, expiry)).digest("base64url"));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "invalid_exact_near_intents_token_invalid" };
  return { ok: true, expiry };
}
