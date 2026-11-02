/**
 * Key checks that never reveal the key: each function returns only public facts (does the secret
 * match this address, what is its public key).
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { base58Decode, base58Encode } from "@penstock/intents-adapter";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** Solana address (base58 public key) for a base58 64-byte secret key, or null if malformed. */
export function solanaAddressOf(secretB58: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(secretB58);
  } catch {
    return null;
  }
  if (bytes.length !== 64) return null;
  const seed = bytes.subarray(0, 32);
  const pub = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" }))
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  // The second half of a Solana secret key is its public key; both must agree.
  if (!Buffer.from(pub).equals(Buffer.from(bytes.subarray(32)))) return null;
  return base58Encode(pub);
}

export function isSolanaAddress(a: string): boolean {
  try {
    return base58Decode(a).length === 32;
  } catch {
    return false;
  }
}

/** `ed25519:...` public key for a NEAR secret key, or null if malformed. */
export function nearPublicKeyOf(secret: string): string | null {
  try {
    return KeyPair.fromString(secret as KeyPairString).getPublicKey().toString();
  } catch {
    return null;
  }
}
