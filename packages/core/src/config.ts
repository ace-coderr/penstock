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

  const adminToken = (env.ADMIN_TOKEN ?? "").trim() || null;
  if (mode === "live" && (!adminToken || adminToken.length < 24)) {
    throw new Error("ADMIN_TOKEN (24+ chars) is required in live mode");
  }

  const sellerNearAccount = (env.SELLER_NEAR_ACCOUNT ?? "").trim() || "tidewater-data.near";
  if (mode === "live" && !env.SELLER_NEAR_ACCOUNT) throw new Error("SELLER_NEAR_ACCOUNT is required in live mode");

  const level = (env.PENSTOCK_LOG ?? "info").toLowerCase();
  return {
    mode,
    port,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    consoleUrl: (env.CONSOLE_URL ?? "http://localhost:5173").replace(/\/+$/, ""),
    dataDir: env.DATA_DIR ?? "./data/runtime",
    operationTokenSecret,
    operationTokenKeyId: (env.OPERATION_TOKEN_KEY_ID ?? "k1").trim() || "k1",
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
