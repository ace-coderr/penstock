import { CHAINS, DESTINATION, USDC_DECIMALS, type AssetInfo } from "@penstock/core";
import type { OneClick, TokenResponse } from "./oneclick";

/**
 * `extra.indicativeAmount` for unquoted entries. Non-binding by definition (the binding amount
 * comes from a real quote), so it is computed from token prices plus a fee buffer, optionally
 * calibrated with real dry quotes in dry and live mode. No per-request network calls.
 */
export interface IndicativePricer {
  indicative(asset: AssetInfo, amountOut: bigint): string | null;
}

export class TokenPricePricer implements IndicativePricer {
  private prices = new Map<string, TokenResponse>();
  /** amountIn per 1 USDC out, measured from dry quotes, keyed by 1Click asset id. */
  private calibrated = new Map<string, { inPerUsdc: number; at: number }>();

  constructor(tokens: TokenResponse[]) {
    this.setTokens(tokens);
  }

  setTokens(tokens: TokenResponse[]): void {
    this.prices = new Map(tokens.map((t) => [t.assetId, t]));
  }

  indicative(asset: AssetInfo, amountOut: bigint): string | null {
    const outUsdc = Number(amountOut) / 10 ** USDC_DECIMALS;
    const cal = this.calibrated.get(asset.oneClickAssetId);
    let units: number;
    if (cal && Date.now() - cal.at < 30 * 60_000) {
      units = cal.inPerUsdc * outUsdc;
    } else {
      const t = this.prices.get(asset.oneClickAssetId);
      if (!t || !(t.price > 0)) return null;
      const buffer = asset.stable ? 0.01 : 0.02;
      units = ((outUsdc * (1 + buffer)) / t.price) * 10 ** asset.decimals;
    }
    if (!Number.isFinite(units) || units <= 0) return null;
    return BigInt(Math.ceil(units)).toString();
  }

  /** Runs one dry quote per origin asset (1 USDC out) and stores the measured rate. */
  async calibrate(oneClick: OneClick, recipient: string, concurrency = 3): Promise<number> {
    const work = CHAINS.flatMap((c) => c.assets.map((a) => ({ c, a }))).filter(({ c, a }) => !(c.key === "near" && a.symbol === "USDC"));
    let done = 0;
    const run = async () => {
      for (let item = work.shift(); item; item = work.shift()) {
        try {
          const q = await oneClick.quote({
            dry: true, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset: item.a.oneClickAssetId, depositType: "ORIGIN_CHAIN",
            destinationAsset: DESTINATION.oneClickAssetId, amount: "1000000", refundTo: item.c.addressExample, refundType: "ORIGIN_CHAIN",
            recipient, recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 600_000).toISOString(),
          });
          this.calibrated.set(item.a.oneClickAssetId, { inPerUsdc: Number(q.quote.amountIn), at: Date.now() });
          done++;
        } catch {
          // Leave this asset on the price-list estimate.
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, run));
    return done;
  }
}
