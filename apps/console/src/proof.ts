import { useEffect, useState } from "react";

/**
 * The real mainnet transactions (docs/proof.json, served same-origin as /proof.json). Nothing in here
 * is simulated; apps/console/test/proof.test.ts keeps it in step with docs/PROOF.md.
 */
export interface ProofStep {
  label: string;
  at: string;
  chain: "solana" | "near";
  hash: string;
  url: string;
}

export interface SignedReceipt {
  body: Record<string, unknown>;
  sig: string;
  pub: string;
}

export interface ProofEntry {
  id: string;
  kind: "payment" | "refund";
  date: string;
  title: string;
  endpoint: string;
  http: number;
  priceUsdc: string;
  paidUsdc?: string;
  usedUsdc?: string;
  deliveredUsdc?: string;
  feesUsdc?: string;
  minAmountInUsdc?: string;
  sentUsdc?: string;
  refundedUsdc?: string;
  refundCostUsdc?: string;
  depositAddress: string;
  oneClick: { status: string; correlationId: string; updatedAt: string; refundReason?: string };
  steps: ProofStep[];
  receipt?: SignedReceipt;
}

export interface Proof {
  simulated: false;
  accounts: { payer: { chain: "solana"; address: string }; seller: { chain: "near"; account: string } };
  nearUsdcContract: string;
  seller: { account: string; snapshotAt: string; exists: boolean; usdcBalance: string; storageRegistered: boolean; source: string };
  entries: ProofEntry[];
}

let cache: Promise<Proof> | null = null;

export function loadProof(): Promise<Proof> {
  cache ??= fetch("/proof.json", { credentials: "omit" }).then((r) => (r.ok ? (r.json() as Promise<Proof>) : Promise.reject(new Error(`proof.json: HTTP ${r.status}`))));
  cache.catch(() => (cache = null));
  return cache;
}

export function useProof(): { proof: Proof | null; error: Error | null } {
  const [s, set] = useState<{ proof: Proof | null; error: Error | null }>({ proof: null, error: null });
  useEffect(() => {
    let live = true;
    loadProof().then((proof) => live && set({ proof, error: null }), (error: Error) => live && set({ proof: null, error }));
    return () => {
      live = false;
    };
  }, []);
  return s;
}
