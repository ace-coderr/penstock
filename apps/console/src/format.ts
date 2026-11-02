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

/*
 * Money formatting: the only place amounts become text.
 *   total: totals and headline figures, always 2 decimals ("$1,234.50").
 *   micro: per-call amounts, 2 to 4 decimals ("$0.004", "$0.0125", "$2.00"); a non-zero amount
 *          below $0.0001 reads "<$0.0001". The exact value is available for a tooltip.
 * A card uses one kind throughout.
 */
export type MoneyKind = "total" | "micro";

function toBig(v: string | bigint): bigint {
  return typeof v === "bigint" ? v : BigInt(v || "0");
}

function grouped(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** USDC base units (6 decimals) as dollars. */
export function money(v: string | bigint, kind: MoneyKind = "total"): string {
  const n = toBig(v);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const sign = neg ? "-" : "";
  if (kind === "total") {
    const cents = (a + 5_000n) / 10_000n; // round half up to 2 decimals
    return `${sign}$${grouped((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, "0")}`;
  }
  if (a > 0n && a < 100n) return `${sign}<$0.0001`;
  const tenThousandths = (a + 50n) / 100n; // round half up to 4 decimals
  const whole = tenThousandths / 10_000n;
  let frac = (tenThousandths % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${sign}$${grouped(whole.toString())}.${frac}`;
}

/** A dollar amount held as a float (route fees in USD). */
export function moneyUsd(n: number, kind: MoneyKind = "total"): string {
  return money(BigInt(Math.round(n * 1e6)), kind);
}

/** Full precision for tooltips: "0.004000 USDC". */
export function moneyExact(v: string | bigint): string {
  const s = units(toBig(v), 6, 6);
  const [w, f = ""] = s.split(".");
  return `${w}.${f.padEnd(6, "0")} USDC`;
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
