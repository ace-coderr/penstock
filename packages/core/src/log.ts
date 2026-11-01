/** Minimal structured logger with redaction. Logs never carry tokens, signatures, keys or raw IPs. */

const SECRET_KEYS = /(token|secret|signature|authorization|apikey|api_key|jwt|password|privatekey|secretkey|operationtoken|payment-signature|cookie)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 300) return value.slice(0, 300) + "…";
  return value;
}

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const lvl = (process.env.PENSTOCK_LOG ?? "info").toLowerCase();
  if (lvl === "silent") return 100;
  return lvl === "debug" ? 10 : 20;
}

export function log(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (order[level] < threshold()) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(fields ? (redact(fields) as object) : {}) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const _redactForTest = redact;
