/**
 * The only module that knows the 1Click Swap API (the documented NEAR Intents integration, API
 * 0.1.10) and the near-intents x402 wire shape. That wire shape follows an unofficial community
 * draft of an x402 "near-intents" transfer method where it helps; it is not an official x402
 * scheme and Penstock makes no conformance claim. Everything draft-specific stays in this package.
 */
import type { PenstockConfig } from "@penstock/core";
import { HttpOneClick, type OneClick } from "./oneclick";
import { DryOneClick, SimulatedOneClick, recordedTokens } from "./oneclick-sim";
import { NearIntentsMethod, type ConfidentialityChooser } from "./method";
import { TokenPricePricer } from "./pricing";
import { RoutePlanner } from "./routes";

/** Follows an unofficial draft; not an official x402 scheme, no conformance claim. */
export const NEAR_INTENTS_SPEC_VERSION = "unofficial-draft";
export const NEAR_INTENTS_SPEC_SOURCE = "https://github.com/ace-coderr/penstock/blob/main/docs/SPEC-NOTES.md#6-near-intents-transfer-method-unofficial-draft";
/** `info.version` of the official 1Click OpenAPI document this client is written against. */
export const ONECLICK_API_VERSION = "0.1.10";
export const ONECLICK_API_DOCS = "https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api";

export * from "./oneclick";
export * from "./quote-signature";
export * from "./oneclick-sim";
export * from "./token";
export * from "./method";
export * from "./pricing";
export * from "./routes";
export * from "./client";

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

export function createIntentsStack(config: PenstockConfig, opts: { confidentiality?: ConfidentialityChooser; oneClick?: OneClick; recipientCheck?: (account: string) => Promise<{ ok: boolean; message: string }> } = {}): IntentsStack {
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
  const method = new NearIntentsMethod({ oneClick, keys, pricer, simulated: config.mode !== "live", confidentiality: opts.confidentiality, recipientCheck: opts.recipientCheck });
  return {
    oneClick, method, pricer, sim, planner: new RoutePlanner(oneClick),
    async warm() {
      if (config.mode === "demo") return;
      pricer.setTokens(await oneClick.tokens());
      await pricer.calibrate(oneClick, config.sellerNearAccount);
    },
  };
}
