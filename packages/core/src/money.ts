/** Integer base-unit arithmetic. Never use floats for amounts that move. */

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** "0.005" with 6 decimals -> 5000n. Throws on malformed input or excess precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const m = DECIMAL.exec(value.trim());
  if (!m) throw new Error(`invalid decimal amount: ${value}`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`too many decimals in ${value} (max ${decimals})`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 5000n with 6 decimals -> "0.005". */
export function formatUnits(value: bigint | string, decimals: number, maxFraction = decimals): string {
  const v = typeof value === "bigint" ? value : BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (frac === "") frac = "";
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function isBaseUnits(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,40}$/.test(value);
}

/** USDC base units (6 dp) -> "$0.0050" style string for the ledger. */
export function usd(baseUnits: bigint | string, digits = 4): string {
  const v = typeof baseUnits === "bigint" ? baseUnits : BigInt(baseUnits);
  return `$${Number(formatUnits(v, 6)).toFixed(digits)}`;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
