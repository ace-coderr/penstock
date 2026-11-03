/**
 * Read-only NEAR mainnet reads from the browser: public chain data, no keys, no wallet. Two RPCs from
 * different providers, both checked to send `Access-Control-Allow-Origin: *` (2026-11-03); the
 * hosted site's CSP allows exactly these two origins in connect-src.
 */
export const NEAR_RPCS = ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"] as const;
export const NEAR_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** NEAR account id rules (named or 64-hex implicit), so typos are caught before any request. */
export function isNearAccountId(s: string): boolean {
  return ACCOUNT.test(s);
}

export class ChainUnreachable extends Error {}

type Fetch = typeof fetch;

async function query<T>(params: object, f: Fetch, timeoutMs: number): Promise<{ result: T | null; rpc: string }> {
  let last: unknown = null;
  for (const rpc of NEAR_RPCS) {
    try {
      const res = await f(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "penstock", method: "query", params: { finality: "final", ...params } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = (await res.json()) as { result?: T; error?: { cause?: { name?: string } } };
      if (j.result !== undefined) return { result: j.result, rpc };
      // A definite "does not exist" is an answer, not an outage.
      if (/UNKNOWN_ACCOUNT/.test(j.error?.cause?.name ?? "")) return { result: null, rpc };
      last = j.error;
    } catch (e) {
      last = e;
    }
  }
  throw new ChainUnreachable(`no NEAR RPC answered (${String((last as Error)?.message ?? last).slice(0, 120)})`);
}

async function view<T>(method: string, args: object, f: Fetch, timeoutMs: number): Promise<{ value: T; rpc: string }> {
  const { result, rpc } = await query<{ result: number[] }>(
    { request_type: "call_function", account_id: NEAR_USDC, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    f, timeoutMs,
  );
  if (!result) throw new ChainUnreachable("USDC contract did not answer");
  return { value: JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T, rpc };
}

export interface AccountState {
  account: string;
  exists: boolean;
  /** USDC base units (6 decimals); "0" when the account does not exist. */
  usdcBalance: string;
  storageRegistered: boolean;
  rpc: string;
  at: string;
}

/** Account existence, USDC balance and USDC storage registration, read live from mainnet. */
export async function readAccount(account: string, f: Fetch = fetch, timeoutMs = 8000): Promise<AccountState> {
  const acct = await query<{ amount: string }>({ request_type: "view_account", account_id: account }, f, timeoutMs);
  const at = new Date().toISOString();
  if (!acct.result) return { account, exists: false, usdcBalance: "0", storageRegistered: false, rpc: acct.rpc, at };
  const [bal, storage] = await Promise.all([
    view<string>("ft_balance_of", { account_id: account }, f, timeoutMs),
    view<unknown>("storage_balance_of", { account_id: account }, f, timeoutMs),
  ]);
  return { account, exists: true, usdcBalance: bal.value, storageRegistered: storage.value !== null, rpc: acct.rpc, at };
}
