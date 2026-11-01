import { NEAR_RPC_URLS } from "@x402/near";
import { isValidNearAccount, type Mode, type Store } from "@penstock/core";

/**
 * Does the seller's payout account exist on NEAR mainnet? 1Click answers a quote for a missing
 * recipient with an opaque HTTP 400 ("Internal server error", seen live on 2026-11-01), so
 * Penstock checks first and tells the seller in plain words.
 *
 * demo: simulated check against the seeded accounts (no network).
 * dry/live: NEAR JSON-RPC `query` / `view_account` at final finality.
 */

export interface AccountCheck {
  account: string;
  exists: boolean | null;
  method: "rpc" | "simulated" | "format";
  message: string;
  checkedAt: number;
}

export class AccountChecker {
  private readonly cache = new Map<string, AccountCheck>();

  constructor(private readonly mode: Mode, private readonly store: Store, private readonly rpcUrl = NEAR_RPC_URLS["near:mainnet"], private readonly fetchImpl: typeof fetch = fetch) {}

  cached(account: string): AccountCheck | undefined {
    return this.cache.get(account);
  }

  async check(account: string): Promise<AccountCheck> {
    const hit = this.cache.get(account);
    if (hit && hit.exists !== null && Date.now() - hit.checkedAt < 600_000) return hit;
    const result = await this.run(account);
    this.cache.set(account, result);
    return result;
  }

  private async run(account: string): Promise<AccountCheck> {
    const now = Date.now();
    if (!isValidNearAccount(account)) {
      return { account, exists: false, method: "format", message: `"${account}" is not a valid NEAR account id.`, checkedAt: now };
    }
    if (this.mode === "demo") {
      const known = this.store.listSellers().some((s) => s.nearAccount === account);
      return {
        account, exists: known, method: "simulated", checkedAt: now,
        message: known ? `${account} exists (simulated check: demo accounts only).` : `${account} was not found (simulated check). In live mode Penstock asks NEAR RPC; 1Click rejects quotes to accounts that do not exist.`,
      };
    }
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "penstock", method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }),
        signal: AbortSignal.timeout(8000),
      });
      const body = (await res.json()) as { result?: unknown; error?: { cause?: { name?: string }; data?: string; message?: string } };
      if (body.result) return { account, exists: true, method: "rpc", message: `${account} exists on NEAR mainnet.`, checkedAt: now };
      const text = JSON.stringify(body.error ?? {});
      if (/UNKNOWN_ACCOUNT|does not exist/i.test(text)) {
        return { account, exists: false, method: "rpc", message: `${account} does not exist on NEAR mainnet. Create it (any NEAR wallet) before selling: 1Click rejects quotes to missing accounts.`, checkedAt: now };
      }
      return { account, exists: null, method: "rpc", message: "NEAR RPC returned an unexpected error; will retry.", checkedAt: now };
    } catch {
      return { account, exists: null, method: "rpc", message: "NEAR RPC unreachable; account not verified yet.", checkedAt: now };
    }
  }
}
