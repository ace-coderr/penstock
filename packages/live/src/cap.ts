/**
 * The spend cap for real sends. Every live script calls `assertWithinCap` with the USD value of
 * what it is about to send (from the 1Click quote) before signing anything.
 */
export class SpendCapError extends Error {}

export function assertWithinCap(usd: number, maxUsd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) throw new SpendCapError(`refusing to send: amount ${usd} USD is not a positive number`);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new SpendCapError("refusing to send: LIVE_MAX_USD is not a positive number");
  if (usd > maxUsd) throw new SpendCapError(`refusing to send: ${usd.toFixed(4)} USD is over LIVE_MAX_USD ${maxUsd}`);
}
