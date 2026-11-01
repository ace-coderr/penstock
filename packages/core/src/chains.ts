/**
 * Chains and assets Penstock offers as payment origins.
 *
 * `oneClickAssetId` values were copied from the live 1Click `GET /v0/tokens` list on 2026-11-01
 * (recorded in packages/intents-adapter/fixtures/tokens.2026-11-01.json; a test cross-checks them).
 * `x402Asset` is the identifier used in x402 `accepts[].asset`: the token contract/mint for
 * tokens, and a CAIP-19 `slip44:<coin>` reference for native coins (Penstock's choice; the
 * near-intents draft says "the network's canonical identifier" without fixing one for natives).
 */

export interface AssetInfo {
  symbol: string;
  decimals: number;
  x402Asset: string;
  oneClickAssetId: string;
  /** USD reference price from the recorded token list; only used for simulated quotes. */
  refPriceUsd: number;
  stable: boolean;
}

export interface ChainInfo {
  /** 1Click `blockchain` value. */
  key: string;
  caip2: `${string}:${string}`;
  label: string;
  /** Three-letter tag used in the ledger UI. */
  tag: string;
  /** Flow-line colour in the console. */
  color: string;
  addressPattern: RegExp;
  addressExample: string;
  /** Typical deposit confirmation window, seconds; sizes maxTimeoutSeconds per origin. */
  depositWindowSec: number;
  /**
   * Smallest USDC amount (base units) 1Click would deliver from this chain, observed live on
   * 2026-11-01 ("Amount is too low for bridge, try at least N"). Real values move with gas;
   * dry/live read them from 1Click errors. Used by the simulation and as a hint.
   */
  routeMinimumUsdc: number;
  assets: AssetInfo[];
}

const EVM = /^0x[0-9a-fA-F]{40}$/;
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const NEAR_USDC_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const NEAR_USDC_ONECLICK = `nep141:${NEAR_USDC_CONTRACT}`;
export const USDC_DECIMALS = 6;

export const CHAINS: ChainInfo[] = [
  {
    key: "near", caip2: "near:mainnet", label: "NEAR", tag: "NEA", color: "#7fd6b5",
    addressPattern: NEAR_ACCOUNT, addressExample: "buyer.near", depositWindowSec: 300, routeMinimumUsdc: 0,
    assets: [
      { symbol: "USDC", decimals: 6, x402Asset: NEAR_USDC_CONTRACT, oneClickAssetId: NEAR_USDC_ONECLICK, refPriceUsd: 0.999969, stable: true },
      { symbol: "USDT", decimals: 6, x402Asset: "usdt.tether-token.near", oneClickAssetId: "nep141:usdt.tether-token.near", refPriceUsd: 0.999492, stable: true },
      { symbol: "wNEAR", decimals: 24, x402Asset: "wrap.near", oneClickAssetId: "nep141:wrap.near", refPriceUsd: 4.36, stable: false },
    ],
  },
  {
    key: "eth", caip2: "eip155:1", label: "Ethereum", tag: "ETH", color: "#9aa6f2",
    addressPattern: EVM, addressExample: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", depositWindowSec: 900, routeMinimumUsdc: 299969,
    assets: [
      { symbol: "USDC", decimals: 6, x402Asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", oneClickAssetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", refPriceUsd: 0.999969, stable: true },
      { symbol: "USDT", decimals: 6, x402Asset: "0xdac17f958d2ee523a2206206994597c13d831ec7", oneClickAssetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", refPriceUsd: 0.999492, stable: true },
      { symbol: "ETH", decimals: 18, x402Asset: "slip44:60", oneClickAssetId: "nep141:eth.omft.near", refPriceUsd: 2266.37, stable: false },
    ],
  },
  {
    key: "arb", caip2: "eip155:42161", label: "Arbitrum", tag: "ARB", color: "#6fb3e8",
    addressPattern: EVM, addressExample: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", depositWindowSec: 300, routeMinimumUsdc: 5298,
    assets: [
      { symbol: "USDC", decimals: 6, x402Asset: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", oneClickAssetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", refPriceUsd: 0.999969, stable: true },
      { symbol: "ETH", decimals: 18, x402Asset: "slip44:60", oneClickAssetId: "nep141:arb.omft.near", refPriceUsd: 2266.37, stable: false },
    ],
  },
  {
    key: "base", caip2: "eip155:8453", label: "Base", tag: "BAS", color: "#5d8df0",
    addressPattern: EVM, addressExample: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", depositWindowSec: 300, routeMinimumUsdc: 149990,
    assets: [
      { symbol: "USDC", decimals: 6, x402Asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", oneClickAssetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", refPriceUsd: 0.999969, stable: true },
      { symbol: "ETH", decimals: 18, x402Asset: "slip44:60", oneClickAssetId: "nep141:base.omft.near", refPriceUsd: 2266.37, stable: false },
    ],
  },
  {
    key: "op", caip2: "eip155:10", label: "Optimism", tag: "OPT", color: "#e88a8a",
    addressPattern: EVM, addressExample: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", depositWindowSec: 300, routeMinimumUsdc: 0,
    assets: [
      { symbol: "USDC", decimals: 6, x402Asset: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", oneClickAssetId: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ", refPriceUsd: 0.999969, stable: true },
      { symbol: "ETH", decimals: 18, x402Asset: "slip44:60", oneClickAssetId: "nep245:v2_1.omni.hot.tg:10_11111111111111111111", refPriceUsd: 2266.37, stable: false },
    ],
  },
  {
    key: "pol", caip2: "eip155:137", label: "Polygon", tag: "POL", color: "#b48ef0",
    addressPattern: EVM, addressExample: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", depositWindowSec: 300, routeMinimumUsdc: 6741,
    assets: [
      { symbol: "USDC", decimals: 6, x402Asset: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", oneClickAssetId: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L", refPriceUsd: 0.999969, stable: true },
      { symbol: "POL", decimals: 18, x402Asset: "slip44:966", oneClickAssetId: "nep245:v2_1.omni.hot.tg:137_11111111111111111111", refPriceUsd: 0.092721, stable: false },
    ],
  },
  {
    key: "avax", caip2: "eip155:43114", label: "Avalanche", tag: "AVX", color: "#e0a66b",
    addressPattern: EVM, addressExample: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", depositWindowSec: 300, routeMinimumUsdc: 5845,
    assets: [
      { symbol: "USDC", decimals: 6, x402Asset: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", oneClickAssetId: "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o", refPriceUsd: 0.999969, stable: true },
      { symbol: "AVAX", decimals: 18, x402Asset: "slip44:9000", oneClickAssetId: "nep245:v2_1.omni.hot.tg:43114_11111111111111111111", refPriceUsd: 8.9, stable: false },
    ],
  },
  {
    key: "sol", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", label: "Solana", tag: "SOL", color: "#c7a8f5",
    addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, addressExample: "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK", depositWindowSec: 300, routeMinimumUsdc: 94115,
    assets: [
      { symbol: "USDC", decimals: 6, x402Asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", oneClickAssetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", refPriceUsd: 0.999969, stable: true },
      { symbol: "SOL", decimals: 9, x402Asset: "slip44:501", oneClickAssetId: "nep141:sol.omft.near", refPriceUsd: 95.38, stable: false },
    ],
  },
  {
    key: "btc", caip2: "bip122:000000000019d6689c085ae165831e93", label: "Bitcoin", tag: "BTC", color: "#f0b65d",
    addressPattern: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/, addressExample: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", depositWindowSec: 3600, routeMinimumUsdc: 6454605,
    assets: [
      { symbol: "BTC", decimals: 8, x402Asset: "slip44:0", oneClickAssetId: "nep141:btc.omft.near", refPriceUsd: 77793, stable: false },
    ],
  },
];

export const DESTINATION = {
  network: "near:mainnet" as const,
  asset: NEAR_USDC_CONTRACT,
  oneClickAssetId: NEAR_USDC_ONECLICK,
  decimals: USDC_DECIMALS,
  symbol: "USDC",
};

export function chainByKey(key: string): ChainInfo | undefined {
  return CHAINS.find((c) => c.key === key);
}

export function chainByCaip2(caip2: string): ChainInfo | undefined {
  return CHAINS.find((c) => c.caip2 === caip2);
}

export function assetOn(chain: ChainInfo, x402AssetOrSymbol: string): AssetInfo | undefined {
  const needle = x402AssetOrSymbol.toLowerCase();
  return chain.assets.find((a) => a.x402Asset.toLowerCase() === needle || a.symbol.toLowerCase() === needle);
}

export function isValidAddress(chain: ChainInfo, address: string): boolean {
  return typeof address === "string" && chain.addressPattern.test(address);
}

export function isValidNearAccount(account: string): boolean {
  return NEAR_ACCOUNT.test(account);
}
