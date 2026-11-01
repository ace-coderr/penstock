import { CHAINS, DESTINATION, chainByKey, assetOn, formatUnits, type AssetInfo, type ChainInfo } from "@penstock/core";
import { parseRouteMinimum, type OneClick } from "./oneclick";

/**
 * "Pay with any token": given what a buyer holds, quote every route to USDC on NEAR and rank them
 * by what the buyer actually spends (USD value in), then by time. NEAR USDC goes direct via the
 * standard exact scheme and costs nothing extra.
 */

export interface Holding {
  chain: string;
  symbol: string;
  /** Balance in base units, if known. Routes the buyer cannot afford are ranked last. */
  balance?: string;
}

export interface RankedRoute {
  chain: string;
  chainLabel: string;
  network: string;
  symbol: string;
  asset: string;
  method: "exact-near" | "near-intents";
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: number;
  amountOutUsd: number;
  feeUsd: number;
  feePct: number;
  timeEstimateSec: number;
  affordable: boolean | null;
  source: "1click-dry-quote" | "simulated-quote" | "direct";
  /** Set when the price is below this route's bridge minimum: pay via a prepaid session of at least this much. */
  minAmountOut?: string;
  error?: string;
}

export class RoutePlanner {
  constructor(private readonly oneClick: OneClick) {}

  get source(): RankedRoute["source"] {
    return this.oneClick.kind === "simulated" ? "simulated-quote" : "1click-dry-quote";
  }

  async rank(holdings: Holding[], amountOut: bigint, recipient: string): Promise<RankedRoute[]> {
    const items = (holdings.length ? holdings : CHAINS.flatMap((c) => c.assets.map((a) => ({ chain: c.key, symbol: a.symbol }))))
      .map((h) => {
        const chain = chainByKey(h.chain);
        const asset = chain && assetOn(chain, h.symbol);
        return chain && asset ? { h, chain, asset } : null;
      })
      .filter((x): x is { h: Holding; chain: ChainInfo; asset: AssetInfo } => x !== null)
      .slice(0, 24);

    const outUsd = Number(formatUnits(amountOut, DESTINATION.decimals));
    const results = await mapLimit(items, 4, async ({ h, chain, asset }): Promise<RankedRoute> => {
      const base = { chain: chain.key, chainLabel: chain.label, network: chain.caip2, symbol: asset.symbol, asset: asset.x402Asset };
      const afford = (amountIn: string) => (h.balance === undefined ? null : /^\d+$/.test(h.balance) ? BigInt(h.balance) >= BigInt(amountIn) : null);
      if (chain.key === "near" && asset.symbol === "USDC") {
        return { ...base, method: "exact-near", amountIn: amountOut.toString(), amountInFormatted: formatUnits(amountOut, 6), amountInUsd: outUsd, amountOutUsd: outUsd, feeUsd: 0, feePct: 0, timeEstimateSec: 2, affordable: afford(amountOut.toString()), source: "direct" };
      }
      try {
        const q = await this.oneClick.quote({
          dry: true, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset: asset.oneClickAssetId, depositType: "ORIGIN_CHAIN",
          destinationAsset: DESTINATION.oneClickAssetId, amount: amountOut.toString(), refundTo: chain.addressExample, refundType: "ORIGIN_CHAIN",
          recipient, recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + chain.depositWindowSec * 1000).toISOString(),
        });
        const inUsd = Number(q.quote.amountInUsd);
        const oUsd = Number(q.quote.amountOutUsd);
        const fee = Math.max(0, inUsd - oUsd);
        return {
          ...base, method: "near-intents", amountIn: q.quote.amountIn, amountInFormatted: q.quote.amountInFormatted, amountInUsd: inUsd, amountOutUsd: oUsd,
          feeUsd: Number(fee.toFixed(6)), feePct: oUsd > 0 ? Number(((fee / oUsd) * 100).toFixed(2)) : 0, timeEstimateSec: q.quote.timeEstimate,
          affordable: afford(q.quote.amountIn), source: this.source,
        };
      } catch (e) {
        const min = parseRouteMinimum((e as Error).message);
        if (min !== null) {
          return { ...base, method: "near-intents", amountIn: "0", amountInFormatted: "0", amountInUsd: Infinity, amountOutUsd: 0, feeUsd: 0, feePct: 0, timeEstimateSec: 0, affordable: null, source: this.source, minAmountOut: min.toString(), error: `below the route minimum of ${formatUnits(min, DESTINATION.decimals)} USDC: use a prepaid session` };
        }
        return { ...base, method: "near-intents", amountIn: "0", amountInFormatted: "0", amountInUsd: Infinity, amountOutUsd: 0, feeUsd: 0, feePct: 0, timeEstimateSec: 0, affordable: false, source: this.source, error: (e as Error).message.slice(0, 160) };
      }
    });

    return results.sort((a, b) => {
      const af = (r: RankedRoute) => (r.error ? 2 : r.affordable === false ? 1 : 0);
      return af(a) - af(b) || a.amountInUsd - b.amountInUsd || a.timeEstimateSec - b.timeEstimateSec;
    });
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  }));
  return out;
}
