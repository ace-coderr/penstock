/**
 * Penstock receipt verification in the browser, with the same rules as `verifyReceipt` in
 * @penstock/core: an ed25519 signature (base64url) over the canonical JSON of `body` (keys sorted,
 * undefined members dropped), checked against the raw public key in `pub` (base64url). Uses WebCrypto
 * only; nothing leaves the page.
 */
import type { SignedReceipt } from "./proof";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type Verdict = { valid: true } | { valid: false; reason: string };

export async function verifyReceipt(r: SignedReceipt, subtle: SubtleCrypto = crypto.subtle): Promise<Verdict> {
  let key: CryptoKey;
  try {
    if (fromBase64url(r.pub).length !== 32) return { valid: false, reason: "the public key is not 32 bytes" };
    key = await subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: r.pub }, { name: "Ed25519" }, false, ["verify"]);
  } catch (e) {
    const unsupported = (e as Error).name === "NotSupportedError";
    return { valid: false, reason: unsupported ? "this browser has no Ed25519 in WebCrypto; use a current Chrome, Edge, Firefox or Safari" : "the public key could not be read" };
  }
  try {
    const sig = fromBase64url(r.sig);
    if (sig.length !== 64) return { valid: false, reason: "the signature is not 64 bytes" };
    const ok = await subtle.verify({ name: "Ed25519" }, key, sig, new TextEncoder().encode(canonicalJson(r.body)));
    return ok ? { valid: true } : { valid: false, reason: "the signature does not match the receipt body" };
  } catch {
    return { valid: false, reason: "the signature could not be checked" };
  }
}

/** Accepts a receipt as JSON, or the base64url value of a PENSTOCK-RECEIPT response header. */
export function parseReceipt(text: string): SignedReceipt | null {
  const t = text.trim();
  if (!t) return null;
  const tryJson = (s: string) => {
    try {
      const j = JSON.parse(s) as SignedReceipt;
      return j && typeof j === "object" && j.body && typeof j.sig === "string" && typeof j.pub === "string" ? j : null;
    } catch {
      return null;
    }
  };
  if (t.startsWith("{")) return tryJson(t);
  try {
    return tryJson(new TextDecoder().decode(fromBase64url(t.replace(/^penstock-receipt:\s*/i, ""))));
  } catch {
    return null;
  }
}
