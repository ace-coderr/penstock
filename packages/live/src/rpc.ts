/** Minimal read-only JSON-RPC calls for NEAR and Solana mainnet. */

export const NEAR_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function rpc<T>(url: string, method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await res.json()) as { result?: T; error?: { message?: string; data?: unknown; cause?: { name?: string } } };
  if (j.error) throw new Error(`${method}: ${j.error.cause?.name ?? j.error.message ?? "RPC error"}`);
  return j.result as T;
}

export interface NearAccount { amount: string; storage_usage: number }

export async function nearViewAccount(url: string, accountId: string): Promise<NearAccount | null> {
  try {
    return await rpc<NearAccount>(url, "query", { request_type: "view_account", finality: "final", account_id: accountId });
  } catch (e) {
    if (/UNKNOWN_ACCOUNT|does not exist/i.test(String(e))) return null;
    throw e;
  }
}

export async function nearView<T>(url: string, contract: string, method: string, args: object): Promise<T> {
  const r = await rpc<{ result: number[] }>(url, "query", {
    request_type: "call_function", finality: "final", account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}

export async function solanaLamports(url: string, address: string): Promise<bigint> {
  const r = await rpc<{ value: number }>(url, "getBalance", [address, { commitment: "confirmed" }]);
  return BigInt(r.value);
}

/** Total USDC (base units) the owner holds across its token accounts for the USDC mint. */
export async function solanaUsdc(url: string, owner: string): Promise<bigint> {
  const r = await rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
    url, "getTokenAccountsByOwner", [owner, { mint: SOLANA_USDC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }],
  );
  return r.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
}
