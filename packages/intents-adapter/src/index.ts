/**
 * The only module that knows the near-intents wire shape (x402 `exact` + `assetTransferMethod:
 * "near-intents"`, draft in x402-foundation/x402 PR #3370 by Iker) and the 1Click API shape.
 */
import type { PenstockConfig } from "@penstock/core";
import { HttpOneClick, type OneClick } from "./oneclick";
import { DryOneClick, SimulatedOneClick, recordedTokens } from "./oneclick-sim";
import { NearIntentsMethod, type ConfidentialityChooser } from "./method";
import { TokenPricePricer } from "./pricing";
import { RoutePlanner } from "./routes";

export const NEAR_INTENTS_SPEC_VERSION = "nearintents-draft-2e9dded";
export const NEAR_INTENTS_SPEC_SOURCE = "https://github.com/x402-foundation/x402/pull/3370 (specs/schemes/exact/scheme_exact_nearintents.md @ 2e9dded9)";
export const ONECLICK_API_VERSION = "0.1.10";

export * from "./oneclick";
export * from "./oneclick-sim";
export * from "./token";
export * from "./method";
export * from "./pricing";
export * from "./routes";

export interface IntentsStack {
  oneClick: OneClick;
  method: NearIntentsMethod;
  planner: RoutePlanner;
  pricer: TokenPricePricer;
  /** Present in demo and dry mode: accepts simulated deposits. */
  sim: SimulatedOneClick | null;
  /** Calibrates indicative amounts with real dry quotes (dry/live only). */
  warm(): Promise<void>;
}

export function createIntentsStack(config: PenstockConfig, opts: { confidentiality?: ConfidentialityChooser; oneClick?: OneClick } = {}): IntentsStack {
  const keys = { currentKeyId: config.operationTokenKeyId, keys: new Map([[config.operationTokenKeyId, config.operationTokenSecret]]) };
  let oneClick: OneClick;
  let sim: SimulatedOneClick | null = null;
  if (opts.oneClick) {
    oneClick = opts.oneClick;
    sim = oneClick instanceof SimulatedOneClick ? oneClick : oneClick instanceof DryOneClick ? oneClick.sim : null;
  } else if (config.mode === "demo") {
    sim = new SimulatedOneClick({ authenticated: !!config.oneClickJwt || config.shieldedConfidentialIntents });
    oneClick = sim;
  } else {
    const http = new HttpOneClick({ baseUrl: config.oneClickBaseUrl, jwt: config.oneClickJwt });
    if (config.mode === "dry") {
      const dry = new DryOneClick(http);
      sim = dry.sim;
      oneClick = dry;
    } else {
      oneClick = http;
    }
  }
  const pricer = new TokenPricePricer(recordedTokens());
  const method = new NearIntentsMethod({ oneClick, keys, pricer, simulated: config.mode !== "live", confidentiality: opts.confidentiality });
  return {
    oneClick, method, pricer, sim, planner: new RoutePlanner(oneClick),
    async warm() {
      if (config.mode === "demo") return;
      pricer.setTokens(await oneClick.tokens());
      await pricer.calibrate(oneClick, config.sellerNearAccount);
    },
  };
}
