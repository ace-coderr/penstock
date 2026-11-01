export type ShieldedRouteId = "confidential-intents" | "aurora";

export interface ShieldedRouteStatus {
  id: ShieldedRouteId;
  enabled: boolean;
  reason: string;
}
