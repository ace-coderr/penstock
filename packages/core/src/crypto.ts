import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SignedReceipt } from "./types";

/** JSON with sorted keys, so signatures do not depend on insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A stable, non-reversible handle for a buyer, used by the funnel. Derived with a keyed hash so
 * the stored value cannot be turned back into an IP address or agent id.
 */
export function buyerHandle(secret: Buffer, parts: string[]): string {
  return "b_" + createHmac("sha256", secret).update(parts.join("|")).digest("base64url").slice(0, 12);
}

export class ReceiptSigner {
  private readonly priv: KeyObject;
  readonly pub: string;

  constructor(priv: KeyObject) {
    this.priv = priv;
    const jwk = createPublicKey(priv).export({ format: "jwk" });
    this.pub = String(jwk.x);
  }

  static ephemeral(): ReceiptSigner {
    return new ReceiptSigner(generateKeyPairSync("ed25519").privateKey);
  }

  /** Loads the instance key from `dir/receipt-key.pem`, creating it (mode 0600) on first run. */
  static fromDir(dir: string): ReceiptSigner {
    const file = join(dir, "receipt-key.pem");
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      const { privateKey } = generateKeyPairSync("ed25519");
      writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    }
    return new ReceiptSigner(createPrivateKey(readFileSync(file)));
  }

  sign<T extends object>(body: T): SignedReceipt<T> {
    const sig = sign(null, Buffer.from(canonicalJson(body)), this.priv).toString("base64url");
    return { body, sig, pub: this.pub };
  }
}

export function verifyReceipt(receipt: SignedReceipt<object>): boolean {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: receipt.pub }, format: "jwk" });
    return verify(null, Buffer.from(canonicalJson(receipt.body)), key, Buffer.from(receipt.sig, "base64url"));
  } catch {
    return false;
  }
}
