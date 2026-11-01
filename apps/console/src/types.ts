/** Types mirror apps/proxy/src/admin-api.ts. The console never imports server code. */

export interface Seller { id: string; name: string; nearAccount: string; description: string; simulated: boolean }
export interface AccountCheck { account: string; exists: boolean | null; method: "rpc" | "simulated" | "format"; message: string }
export interface ChainRow { chain: string; label: string; tag: string; color: string; receivedUsdc: string; count: number; refunded: number }
export interface Overview {
  mode: "demo" | "dry" | "live";
  simulation: { quotes: boolean; settlement: boolean; label: string };
  seller: Seller;
  account: AccountCheck;
  days: number;
  receivedUsdc: string;
  revenueUsdc: string;
  upstreamCostUsdc: string;
  payments: number;
  settled: number;
  refunds: number;
  refundedSessionsUsdc: string;
  sessionFloatUsdc: string;
  openSessions: number;
  buyerFeesUsd: number;
  conversion: number | null;
  probes: number;
  byChain: ChainRow[];
  daily: { day: string; receivedUsdc: string; count: number }[];
}
export interface Payment {
  id: string; ts: number; endpointId: string; method: string; status: "settled" | "pending" | "refunded" | "failed";
  originChain: string; originAsset: string; originSymbol: string; amountIn: string; amountInUsd: number; amountOut: string; feeUsd: number;
  payer: string; refundTo: string; depositAddress: string | null; originTx: string | null; destTx: string | null; refundedAmount: string | null;
  refundReason: string | null; operationId: string | null; sessionId: string | null; upstreamCost: string; shielded: boolean; simulated: boolean;
}
export interface Receipt { body: Record<string, unknown>; sig: string; pub: string }
export interface Stage { stage: string; count: number }
export interface Funnel {
  days: number; note: string; buyers: number; stages: Stage[];
  byEndpoint: { endpoint: string; stages: Stage[] }[];
  inferredReasons: { reason: string; stage: string; count: number }[];
  recent: { ts: number; endpoint: string; buyer: string; stage: string; chain: string | null; inferredReason: string | null; paymentId: string | null }[];
}
export interface Session {
  id: string; endpointId: string; buyer: string; capUsdc: string; fundedUsdc: string; spentUsdc: string; settledUsdc: string; status: "open" | "closed";
  openedAt: number; closedAt: number | null; refundUsdc: string | null; refundTo: string; originChain: string; simulated: boolean;
  refundState?: string; refundTx?: string | null; expiresAt?: number | null;
}
export interface EndpointRow {
  id: string; slug: string; kind: string; description: string; capabilities: string[]; priceUsdc: string; upstreamHost: string; url: string;
  methods: string[]; sessionsEnabled: boolean; resaleOf: string[]; calls: number; grossUsdc: string; upstreamCostUsdc: string; marginPerCallUsdc: string | null;
}

export interface Shielded {
  active: string | null;
  routes: { id: string; label: string; enabled: boolean; reason: string }[];
  scope: { hides: string; doesNotHide: string } | null;
  shieldedPayments: number;
}
