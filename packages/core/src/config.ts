import { randomBytes } from "node:crypto";
import type { Mode } from "./types";

export interface PenstockConfig {
  mode: Mode;
  port: number;
  publicUrl: string;
  consoleUrl: string;
  dataDir: string;
  operationTokenSecret: Buffer;
  operationTokenKeyId: string;
  adminToken: string | null;
  sellerNearAccount: string;
  oneClickBaseUrl: string;
  oneClickJwt: string | null;
  facilitatorUrl: string | null;
  facilitatorApiKey: string | null;
  sessionCapUsd: string;
  shieldedConfidentialIntents: boolean;
  shieldedAuroraRpcUrl: string | null;
  logLevel: "debug" | "info" | "silent";
  /** Loopback/private upstreams are allowed in demo and dry mode, refused in live unless opted in. */
  allowPrivateUpstreams: boolean;
  /** Honour X-Forwarded-For (only behind a trusted reverse proxy). */
  trustProxy: boolean;
  /** Listen address: loopback in demo and dry (simulated payments must not be reachable from the network). */
  host: string;
}

export function parseMode(raw: string | undefined): Mode {
  const v = (raw ?? "demo").trim().toLowerCase();
  if (v === "demo" || v === "dry" || v === "live") return v;
  throw new Error(`MODE must be demo, dry or live (got "${raw}")`);
}

function decodeSecret(raw: string): Buffer {
  const hex = /^[0-9a-fA-F]+$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return hex;
}

/** Reads and validates configuration. Live mode refuses to start without its secrets. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PenstockConfig {
  const mode = parseMode(env.MODE);
  const port = Number(env.PORT ?? 4020);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1-65535");

  const rawSecret = (env.OPERATION_TOKEN_SECRET ?? "").trim();
  let operationTokenSecret: Buffer;
  if (rawSecret) {
    operationTokenSecret = decodeSecret(rawSecret);
    if (operationTokenSecret.length < 32) throw new Error("OPERATION_TOKEN_SECRET must decode to at least 32 bytes");
  } else if (mode === "live") {
    throw new Error("OPERATION_TOKEN_SECRET is required in live mode");
  } else {
    operationTokenSecret = randomBytes(32);
  }

  const keyId = (env.OPERATION_TOKEN_KEY_ID ?? "k1").trim() || "k1";
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(keyId)) throw new Error("OPERATION_TOKEN_KEY_ID must be 1-16 letters, digits, '-' or '_'");
  const adminToken = (env.ADMIN_TOKEN ?? "").trim() || null;
  if (mode === "live" && (!adminToken || adminToken.length < 24)) {
    throw new Error("ADMIN_TOKEN (24+ chars) is required in live mode");
  }

  // Demo uses a made-up name (simulated). Dry mode talks to real 1Click, which rejects quotes to
  // NEAR accounts that do not exist, so it defaults to an account that does ("near"); set yours.
  const sellerNearAccount = (env.SELLER_NEAR_ACCOUNT ?? "").trim() || (mode === "dry" ? "near" : "tidewater-data.near");
  if (mode === "live" && !env.SELLER_NEAR_ACCOUNT) throw new Error("SELLER_NEAR_ACCOUNT is required in live mode");

  const level = (env.PENSTOCK_LOG ?? "info").toLowerCase();
  return {
    mode,
    port,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    consoleUrl: (env.CONSOLE_URL ?? "http://localhost:4021").replace(/\/+$/, ""),
    dataDir: env.DATA_DIR ?? "./data/runtime",
    operationTokenSecret,
    operationTokenKeyId: keyId,
    adminToken,
    sellerNearAccount,
    oneClickBaseUrl: (env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com").replace(/\/+$/, ""),
    oneClickJwt: (env.ONECLICK_JWT ?? "").trim() || null,
    facilitatorUrl: (env.FACILITATOR_URL ?? "").trim() || null,
    facilitatorApiKey: (env.FACILITATOR_API_KEY ?? "").trim() || null,
    sessionCapUsd: (env.SESSION_CAP_USD ?? "5").trim() || "5",
    shieldedConfidentialIntents: (env.SHIELDED_CONFIDENTIAL_INTENTS ?? "false").toLowerCase() === "true",
    shieldedAuroraRpcUrl: (env.SHIELDED_AURORA_RPC_URL ?? "").trim() || null,
    logLevel: level === "debug" || level === "silent" ? level : "info",
    allowPrivateUpstreams: mode !== "live" || (env.ALLOW_PRIVATE_UPSTREAMS ?? "").toLowerCase() === "true",
    trustProxy: (env.TRUST_PROXY ?? "").toLowerCase() === "true",
    host: (env.HOST ?? "").trim() || (mode === "live" ? "0.0.0.0" : "127.0.0.1"),
  };
}

/** Which parts of the system are simulated in a mode. Shown verbatim in the console. */
export function simulationScope(mode: Mode): { quotes: boolean; settlement: boolean; label: string } {
  switch (mode) {
    case "demo":
      return { quotes: true, settlement: true, label: "Demo mode: quotes and settlements are simulated. No network, no funds." };
    case "dry":
      return { quotes: false, settlement: true, label: "Dry mode: quotes are real 1Click dry quotes; settlements are simulated. No funds move." };
    case "live":
      return { quotes: false, settlement: false, label: "Live mode: real quotes and real settlement on mainnet." };
  }
}
