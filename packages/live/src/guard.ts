/**
 * The rules that keep a live payment from being sent twice. `live:pay` asks these before it
 * broadcasts or gives up on anything; they are pure so they can be tested.
 */
export type PayStatus = "planned" | "sending" | "sent" | "paid" | "refunded" | "failed" | "abandoned";

export interface GuardState {
  status: PayStatus;
  deposit: { payTo: string; refundDeadline: string };
  txHash?: string;
}

/** Why `send` must refuse, or null when it may broadcast. */
export function sendRefusal(s: GuardState | null, confirm: string | undefined, nowMs: number): string | null {
  if (!s) return "no planned payment: run `pnpm live:pay plan <url>` first";
  if (s.status !== "planned") return `refusing to send: state is "${s.status}"${s.txHash ? ` (tx ${s.txHash})` : ""}; a payment is sent at most once`;
  if (confirm !== s.deposit.payTo) return `refusing to send: --confirm must be the deposit address ${s.deposit.payTo}`;
  if (Date.parse(s.deposit.refundDeadline) - nowMs < 90_000) return "the quote expires in under 90 s: plan again";
  return null;
}

/** Why `plan` must refuse to replace the current state, or null. */
export function planRefusal(s: GuardState | null): string | null {
  if (s && (s.status === "sending" || s.status === "sent")) return `a payment is already in flight (${s.status}, tx ${s.txHash ?? "?"}): run \`pnpm live:pay resume\``;
  return null;
}

/**
 * A send may be abandoned only when its quote deadline has passed and the chain has no record of
 * its transaction, so the funds never left the payer. Anything else is resumed, never resent.
 */
export function abandonRefusal(s: GuardState | null, txFoundOnChain: boolean, nowMs: number): string | null {
  if (!s || (s.status !== "sending" && s.status !== "sent")) return "nothing in flight to abandon";
  if (txFoundOnChain) return `transaction ${s.txHash} is on chain: run \`pnpm live:pay resume\` instead`;
  if (nowMs < Date.parse(s.deposit.refundDeadline) + 120_000) return "wait until two minutes after the quote deadline, then check again";
  return null;
}

/** The operation token is a bearer credential; once a payment is final it is dropped from records. */
export function redactSpent<T extends { deposit: { operationToken?: string } }>(s: T): T {
  return { ...s, deposit: { ...s.deposit, operationToken: "[redacted after use]" } };
}
