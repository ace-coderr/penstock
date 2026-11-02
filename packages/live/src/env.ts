/**
 * Live-proof settings from the environment (`.env`, loaded by `tsx --env-file-if-exists`).
 * Secret values are kept here only to be handed to a signer; nothing in this package prints them.
 */
import { existsSync, readFileSync } from "node:fs";

export interface LiveEnv {
  mode: string;
  sellerAccount: string;
  payerAddress: string;
  payerSecret: string;
  sellerSecret: string;
  oneClickJwt: string;
  oneClickBaseUrl: string;
  solanaRpc: string;
  nearRpc: string;
  maxUsd: number;
}

export function readLiveEnv(env: NodeJS.ProcessEnv = process.env): LiveEnv {
  const v = (k: string, d = "") => (env[k] ?? "").trim() || d;
  const max = Number(v("LIVE_MAX_USD", "1"));
  return {
    mode: v("MODE", "demo"),
    sellerAccount: v("SELLER_NEAR_ACCOUNT"),
    payerAddress: v("PAYER_SOLANA_ADDRESS"),
    payerSecret: v("PAYER_SOLANA_PRIVATE_KEY"),
    sellerSecret: v("SELLER_NEAR_PRIVATE_KEY"),
    oneClickJwt: v("ONECLICK_JWT"),
    oneClickBaseUrl: v("ONECLICK_BASE_URL", "https://1click.chaindefuser.com"),
    solanaRpc: v("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
    nearRpc: v("NEAR_RPC_URL", "https://rpc.mainnet.fastnear.com"),
    // A missing or malformed cap falls back to the default, never to "no cap".
    maxUsd: Number.isFinite(max) && max > 0 ? max : 1,
  };
}

/** 1-based line of `NAME=` in the .env file, so instructions can say exactly where to paste. */
export function envLine(name: string, file = ".env"): number | null {
  if (!existsSync(file)) return null;
  const i = readFileSync(file, "utf8").split(/\r?\n/).findIndex((l) => l.startsWith(`${name}=`));
  return i < 0 ? null : i + 1;
}
