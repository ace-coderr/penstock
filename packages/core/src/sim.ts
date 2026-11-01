/**
 * Shared clock for the simulated NEAR chain used in demo and dry mode. Block height is unix
 * seconds (NEAR produces about one block per second), so the buyer's simulated wallet and the
 * proxy's simulated chain agree on max_block_height windows without talking to each other.
 */
export function simNearBlockHeight(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000));
}

let lastNonce = 0n;

/** Monotonic delegate-action nonce below NEAR's `height * 1e6` bound. */
export function simNearNonce(nowMs: number = Date.now()): bigint {
  const n = BigInt(nowMs) * 100n;
  lastNonce = n > lastNonce ? n : lastNonce + 1n;
  return lastNonce;
}
