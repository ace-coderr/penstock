import type { Payment, Receipt, Seller, Session } from "../types";

/**
 * The hosted demo's data: raw rows produced at build time by the real seed generator
 * (packages/core seedStore), so the static site shows the same demo history as `pnpm demo`.
 * Everything in it is simulated. Receipts were signed at build time with a throwaway key whose
 * private half is never written anywhere.
 */

export interface SnapshotEndpoint {
  id: string;
  sellerId: string;
  slug: string;
  kind: string;
  description: string;
  capabilities: string[];
  priceUsdc: string;
  upstreamUrl: string;
  methods: string[];
  sessionsEnabled: boolean;
  resaleOf: string[];
}

export interface SnapshotProbe {
  id: string;
  ts: number;
  endpointId: string;
  buyer: string;
  originChain: string | null;
  stage: "probed" | "quoted" | "deposited" | "paid" | "refunded";
  inferredReason: string | null;
  paymentId: string | null;
}

export interface SnapshotChain {
  key: string;
  label: string;
  tag: string;
  color: string;
  routeMinimumUsdc: number;
  assets: { symbol: string; decimals: number; x402Asset: string; refPriceUsd: number; stable: boolean }[];
}

export interface Snapshot {
  version: 1;
  generatedAt: number;
  origin: string;
  seller: Seller;
  sellers: Seller[];
  endpoints: SnapshotEndpoint[];
  payments: Payment[];
  probes: SnapshotProbe[];
  sessions: Session[];
  receipts: Record<string, Receipt>;
  chains: SnapshotChain[];
  capUsdc: string;
  shielded: { active: string | null; routes: { id: string; label: string; enabled: boolean; reason: string }[]; scope: { hides: string; doesNotHide: string } };
}
