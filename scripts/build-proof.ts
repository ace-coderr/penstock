/**
 * Builds docs/proof.json, the machine-readable twin of docs/PROOF.md, from the local live-run records
 * in data/live-proof/ (written by `pnpm live:pay`) plus public reads: 1Click status by deposit address,
 * Solana block times and NEAR block times. Run once after a live run; the result is committed and
 * served with the site as /proof.json. apps/console/test/proof.test.ts checks it against PROOF.md.
 *
 *   pnpm tsx scripts/build-proof.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatUnits } from "@penstock/core";

const root = resolve(import.meta.dirname, "..");
const dir = join(root, "data", "live-proof");
const NEAR_RPC = "https://rpc.mainnet.fastnear.com";
const SOL_RPC = "https://api.mainnet-beta.solana.com";
const NEAR_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const usdc = (v: string | number | bigint) => {
  const [w, f = ""] = formatUnits(BigInt(v), 6).split(".");
  return `${w}.${f.padEnd(6, "0")}`;
};

async function retry<T>(fn: () => Promise<T>, n = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= n) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
// External JSON (RPC results, 1Click status) is read loosely in this one-off script.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped external responses
type Loose = any;
const rpc = (url: string, method: string, params: unknown) =>
  retry(async () => {
    const j = (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result?: Loose; error?: unknown };
    if (!j.result) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
    return j.result;
  });
const oneClick = (dep: string) => retry(async () => (await (await fetch(`https://1click.chaindefuser.com/v0/status?depositAddress=${dep}`)).json()) as Loose);
const solTime = async (sig: string) => new Date((await rpc(SOL_RPC, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }])).blockTime * 1000).toISOString();
async function nearTime(hash: string): Promise<string> {
  for (const sender of ["intents.near", "omni-relayer.bridge.near", "relay.tg"]) {
    try {
      const tx = await rpc(NEAR_RPC, "EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
      const blk = await rpc(NEAR_RPC, "block", { block_id: tx.transaction_outcome.block_hash });
      return new Date(Number(BigInt(blk.header.timestamp) / 1_000_000n)).toISOString();
    } catch {
      /* try the next sender */
    }
  }
  throw new Error(`NEAR tx ${hash} not found`);
}
const sol = (hash: string) => ({ chain: "solana", hash, url: `https://solscan.io/tx/${hash}` });
const near = (hash: string) => ({ chain: "near", hash, url: `https://nearblocks.io/txns/${hash}` });

const records = readdirSync(dir).filter((f) => f.startsWith("proof-")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const paid = records.find((r) => r.status === "paid");
const refunded = records.find((r) => r.status === "refunded");
if (!paid || !refunded) throw new Error("need one paid and one refunded record in data/live-proof");

const ps = paid.result.oneClickStatus ?? (await oneClick(paid.deposit.payTo));
const rs = await oneClick(refunded.deposit.payTo);
const pd = ps.swapDetails;
const rd = rs.swapDetails;
const [pBridge, pSwap1, pSwap2, pDeliver] = pd.nearTxHashes as [string, string, string, string];
const [rBridgeIn, rBridgeOut] = rd.nearTxHashes as [string, string];
const refundTx = (rd.originChainTxHashes as { hash: string }[]).map((t) => t.hash).find((h) => h !== refunded.txHash)!;
const dest = paid.unquoted.extra.destination;
const rdest = refunded.unquoted.extra.destination;

const proof = {
  $comment: "Real mainnet transactions, nothing simulated. Human-readable source: docs/PROOF.md (checked by apps/console/test/proof.test.ts).",
  simulated: false,
  accounts: { payer: { chain: "solana", address: paid.result.receipt.body.payer }, seller: { chain: "near", account: dest.recipient } },
  nearUsdcContract: NEAR_USDC,
  entries: [
    {
      id: "payment-1",
      kind: "payment",
      date: "2026-11-02",
      title: "x402 payment from Solana, settled as USDC on NEAR",
      endpoint: "GET /p/tidewater/tides-now",
      http: 200,
      priceUsdc: usdc(dest.amount),
      paidUsdc: usdc(pd.depositedAmount),
      usedUsdc: usdc(pd.amountIn),
      deliveredUsdc: usdc(pd.amountOut),
      feesUsdc: usdc(BigInt(pd.depositedAmount) - BigInt(pd.amountOut)),
      depositAddress: paid.deposit.payTo,
      oneClick: { status: ps.status, correlationId: ps.correlationId, updatedAt: ps.updatedAt },
      steps: [
        { label: "Deposit on Solana", at: await solTime(paid.txHash), ...sol(paid.txHash) },
        { label: "Bridged into NEAR (Omni Bridge)", at: await nearTime(pBridge), ...near(pBridge) },
        { label: "Swap in NEAR Intents", at: await nearTime(pSwap1), ...near(pSwap1) },
        { label: "Swap in NEAR Intents", at: await nearTime(pSwap2), ...near(pSwap2) },
        { label: "Delivered to the seller: storage_deposit, then ft_transfer", at: await nearTime(pDeliver), ...near(pDeliver) },
      ],
      receipt: paid.result.receipt,
    },
    {
      id: "refund-1",
      kind: "refund",
      date: "2026-11-02",
      title: "Under-deposit refused by Penstock and refunded by 1Click",
      endpoint: "GET /p/tidewater/voyage-plan",
      http: 402,
      priceUsdc: usdc(rdest.amount),
      minAmountInUsdc: usdc(rs.quoteResponse.quote.minAmountIn),
      sentUsdc: usdc(rd.depositedAmount),
      refundedUsdc: usdc(rd.refundedAmount),
      refundCostUsdc: usdc(BigInt(rd.depositedAmount) - BigInt(rd.refundedAmount)),
      depositAddress: refunded.deposit.payTo,
      oneClick: { status: rs.status, correlationId: rs.correlationId, updatedAt: rs.updatedAt, refundReason: rd.refundReason },
      steps: [
        { label: "Deposit on Solana (below the required amount)", at: await solTime(refunded.txHash), ...sol(refunded.txHash) },
        { label: "Bridged into NEAR (Omni Bridge)", at: await nearTime(rBridgeIn), ...near(rBridgeIn) },
        { label: "Sent back out through Omni Bridge", at: await nearTime(rBridgeOut), ...near(rBridgeOut) },
        { label: "Refund received on Solana", at: await solTime(refundTx), ...sol(refundTx) },
      ],
    },
  ],
};

writeFileSync(join(root, "docs", "proof.json"), JSON.stringify(proof, null, 2) + "\n");
console.log("wrote docs/proof.json");
