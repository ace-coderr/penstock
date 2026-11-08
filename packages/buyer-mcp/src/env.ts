import type { Holding } from "@penstock/intents-adapter";
import { parseUnits } from "@penstock/core";
import { Journal } from "./journal";
import { PenstockBuyer, simulatedOriginWallet, type OriginWallet } from "./client";
import { liveNearWallet, simulatedNearWallet, type NearWallet } from "./near-wallet";

/**
 * Buyer configuration from the environment.
 *   PENSTOCK_DIRECTORIES  comma-separated discovery URLs (default: local demo proxy)
 *   PENSTOCK_HOLDINGS     chain:symbol[:balance],...   (default: a demo agent that holds no NEAR USDC)
 *   PENSTOCK_SIMULATED    true (default) uses simulated wallets; only a demo/dry proxy accepts them
 *   PENSTOCK_NEAR_ACCOUNT / PENSTOCK_NEAR_KEY   live exact payments on NEAR (full-access key)
 *   PENSTOCK_JOURNAL_DIR  where the operation journal lives (default ./data/buyer-journal); it survives restarts
 *   PENSTOCK_MAX_TOTAL_USD  refuse new purchases once the journal's paid total would pass this (default: no limit)
 */
export const DEMO_HOLDINGS = "base:USDC:2500000,sol:SOL:40000000,arb:ETH:900000000000000,btc:BTC:20000";

export function parseHoldings(raw: string): Holding[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [chain, symbol, balance] = s.split(":");
    return { chain: chain ?? "", symbol: symbol ?? "", ...(balance && /^\d+$/.test(balance) ? { balance } : {}) };
  });
}

export function buyerFromEnv(env: NodeJS.ProcessEnv): { buyer: PenstockBuyer; summary: string } {
  const directories = (env.PENSTOCK_DIRECTORIES ?? "http://localhost:4020/.well-known/penstock.json").split(",").map((s) => s.trim()).filter(Boolean);
  const holdings = parseHoldings(env.PENSTOCK_HOLDINGS ?? DEMO_HOLDINGS);
  const simulated = (env.PENSTOCK_SIMULATED ?? "true").toLowerCase() !== "false";
  let near: NearWallet | undefined;
  let origins: OriginWallet[] = [];
  if (simulated) {
    const proxyBase = new URL(directories[0] ?? "http://localhost:4020").origin;
    near = simulatedNearWallet();
    origins = [...new Set(holdings.map((h) => h.chain))].filter((c) => c !== "near").map((c) => simulatedOriginWallet(c, proxyBase));
  } else if (env.PENSTOCK_NEAR_ACCOUNT && env.PENSTOCK_NEAR_KEY) {
    near = liveNearWallet(env.PENSTOCK_NEAR_ACCOUNT, env.PENSTOCK_NEAR_KEY);
  }
  const journal = new Journal({ dir: env.PENSTOCK_JOURNAL_DIR || "./data/buyer-journal" });
  const maxTotalUsdc = env.PENSTOCK_MAX_TOTAL_USD ? parseUnits(env.PENSTOCK_MAX_TOTAL_USD, 6) : undefined;
  const buyer = new PenstockBuyer({ directories, holdings, near, origins, journal, maxTotalUsdc });
  return { buyer, summary: `${simulated ? "SIMULATED wallets" : "live"}; holdings ${holdings.map((h) => `${h.symbol}@${h.chain}`).join(", ")}; directories ${directories.join(", ")}` };
}
