import type { Mode } from "@penstock/core";

/**
 * Shielded-payer mode. Two routes behind one interface:
 *
 *   confidential-intents  NEAR Intents' Confidential Intents: a normal ORIGIN_CHAIN -> DESTINATION_CHAIN
 *                         1Click quote with `confidentiality: "basic"`, so the payer's deposit and the
 *                         delivery to the seller cannot be linked. Real 1Click requires an authenticated
 *                         call for this (HTTP 401 without one, observed 2026-11-01), so the route is only
 *                         enabled with ONECLICK_JWT (or in demo mode, against the simulated backend).
 *   aurora                Aurora Cloud private chains ("a permissioned chain with fully private data").
 *                         Penstock can connect to one and verify it, but 1Click lists no assets on such a
 *                         chain, so payments cannot route from it: the route reports that and stays off.
 *
 * Neither route is required. With both off, payments are public and everything else works.
 */

export type ShieldedRouteId = "confidential-intents" | "aurora";
export type Confidentiality = "public" | "basic" | "advanced";

export interface ShieldedRouteStatus {
  id: ShieldedRouteId;
  label: string;
  enabled: boolean;
  reason: string;
}

export const PRIVACY_SCOPE = {
  hides: "The payer's origin wallet and route: on Confidential Intents the deposit on the origin chain and the delivery to the seller cannot be linked.",
  doesNotHide: "The USDC delivery to the seller's NEAR account is a public transfer, so the seller's revenue is visible on-chain. The seller still sees the payer's refund address.",
};

export interface ShieldedOptions {
  mode: Mode;
  confidentialIntents: boolean;
  oneClickJwt: string | null;
  auroraRpcUrl: string | null;
  fetchImpl?: typeof fetch;
}

export class ShieldedRoutes {
  private runtimeOff: string | null = null;
  private aurora: ShieldedRouteStatus | null = null;
  private readonly f: typeof fetch;

  constructor(private readonly o: ShieldedOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  private confidential(): ShieldedRouteStatus {
    const base = { id: "confidential-intents" as const, label: "Confidential Intents (NEAR Intents)" };
    if (!this.o.confidentialIntents) return { ...base, enabled: false, reason: "Not enabled. Set SHIELDED_CONFIDENTIAL_INTENTS=true (and ONECLICK_JWT outside demo mode)." };
    if (this.runtimeOff) return { ...base, enabled: false, reason: `Turned off at runtime: ${this.runtimeOff}` };
    if (this.o.mode === "demo") return { ...base, enabled: true, reason: "Enabled against the simulated 1Click backend (simulated)." };
    if (!this.o.oneClickJwt) return { ...base, enabled: false, reason: "Not enabled: 1Click requires an authenticated call for confidential quotes (HTTP 401 without ONECLICK_JWT)." };
    return { ...base, enabled: true, reason: "Enabled: quotes request confidentiality \"basic\" with your 1Click JWT." };
  }

  /** The level the near-intents method asks 1Click for. */
  level(): Confidentiality {
    return this.confidential().enabled ? "basic" : "public";
  }

  /** Called when 1Click refuses a confidential quote; payments fall back to public quotes. */
  unavailable(reason: string): void {
    this.runtimeOff = reason.slice(0, 200);
  }

  private async checkAurora(): Promise<ShieldedRouteStatus> {
    const base = { id: "aurora" as const, label: "Aurora private chain" };
    if (!this.o.auroraRpcUrl) return { ...base, enabled: false, reason: "Not enabled. Set SHIELDED_AURORA_RPC_URL to an Aurora Cloud private chain RPC." };
    try {
      const r = await this.f(this.o.auroraRpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(6000),
      });
      const j = (await r.json()) as { result?: string };
      if (!j.result || !/^0x[0-9a-f]+$/i.test(j.result)) return { ...base, enabled: false, reason: "Not enabled: the RPC did not return a chain id." };
      return { ...base, enabled: false, reason: `Connected to chain ${parseInt(j.result, 16)}, but not enabled for payments: 1Click lists no assets on this chain, so payments cannot route from it yet.` };
    } catch {
      return { ...base, enabled: false, reason: "Not enabled: the Aurora RPC is unreachable." };
    }
  }

  async status(): Promise<{ active: ShieldedRouteId | null; routes: ShieldedRouteStatus[]; scope: typeof PRIVACY_SCOPE }> {
    this.aurora = this.aurora ?? (await this.checkAurora());
    const routes = [this.confidential(), this.aurora];
    return { active: routes.find((r) => r.enabled)?.id ?? null, routes, scope: PRIVACY_SCOPE };
  }
}
