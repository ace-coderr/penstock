export const CHAIN_META: Record<string, { label: string; tag: string; color: string; decimals: Record<string, number> }> = {
  near: { label: "NEAR", tag: "NEA", color: "#7fd6b5", decimals: { USDC: 6, USDT: 6, wNEAR: 24 } },
  eth: { label: "Ethereum", tag: "ETH", color: "#9aa6f2", decimals: { USDC: 6, USDT: 6, ETH: 18 } },
  arb: { label: "Arbitrum", tag: "ARB", color: "#6fb3e8", decimals: { USDC: 6, ETH: 18 } },
  base: { label: "Base", tag: "BAS", color: "#5d8df0", decimals: { USDC: 6, ETH: 18 } },
  op: { label: "Optimism", tag: "OPT", color: "#e88a8a", decimals: { USDC: 6, ETH: 18 } },
  pol: { label: "Polygon", tag: "POL", color: "#b48ef0", decimals: { USDC: 6, POL: 18 } },
  avax: { label: "Avalanche", tag: "AVX", color: "#e0a66b", decimals: { USDC: 6, AVAX: 18 } },
  sol: { label: "Solana", tag: "SOL", color: "#c7a8f5", decimals: { USDC: 6, SOL: 9 } },
  btc: { label: "Bitcoin", tag: "BTC", color: "#f0b65d", decimals: { BTC: 8 } },
};

/** Base units -> decimal string without floating point. */
export function units(v: string | bigint, decimals: number, maxFraction = decimals): string {
  const n = typeof v === "bigint" ? v : BigInt(v || "0");
  const neg = n < 0n;
  const a = neg ? -n : n;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / base}${frac ? "." + frac : ""}`;
}

/** USDC base units -> "$12.3450" with fixed places, so ledger columns align. */
export function usdc(v: string | bigint, places = 4): string {
  const s = units(v, 6, places);
  const [w, f = ""] = s.split(".");
  return `$${Number(w).toLocaleString("en-US")}.${f.padEnd(places, "0")}`;
}

export function usd(n: number, places = 4): string {
  return `$${n.toFixed(places)}`;
}

export function originAmount(chain: string, symbol: string, amount: string): string {
  const d = CHAIN_META[chain]?.decimals[symbol] ?? 6;
  const s = units(amount, d, d > 8 ? 8 : d);
  return `${s} ${symbol}`;
}

export function when(ts: number): string {
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}Z`;
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function short(s: string | null | undefined, n = 10): string {
  if (!s) return "—";
  return s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-6)}`;
}

export function pct(n: number | null, places = 1): string {
  return n === null ? "—" : `${(n * 100).toFixed(places)}%`;
}

export function isSimHash(h: string | null | undefined): boolean {
  return !!h && h.startsWith("sim");
}

export function explorerFor(chain: string, hash: string | null): string | null {
  if (!hash || isSimHash(hash)) return null;
  if (chain === "near") return `https://nearblocks.io/txns/${encodeURIComponent(hash)}`;
  return null;
}
