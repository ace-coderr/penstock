/**
 * `pnpm live:pay`: one real cross-chain x402 payment through a live Penstock proxy, from the payer's
 * USDC on Solana to the seller's USDC on NEAR (docs/LIVE-RUNBOOK.md section 5). Two steps:
 *
 *   pnpm live:pay plan <paid URL>            asks the proxy for a real quote and prints the exact
 *                                           payment. Sends nothing.
 *   pnpm live:pay send --confirm <deposit> [--max-usdc N]   sends that payment (after a human
 *                                           said yes; refuses above the approved bound), then
 *                                           redeems it at the proxy and records the proof.
 *   pnpm live:pay resume                     continues a sent payment (slow 1Click, restart).
 *
 * Refund test: `send --confirm <deposit> --refund-test-usdc N` deliberately sends N, which must be
 * below the quote's minAmountIn (so 1Click refunds it after the deadline) and at least three times
 * 1Click's refundFee (so the refund is worth having). It is still capped by LIVE_MAX_USD.
 *
 * Double-send protection: the state file is written as "sending" before the transfer is broadcast,
 * and `send` refuses any state other than "planned". A sent payment is only ever resumed.
 * The payer key is read from .env, used to sign, and never printed or written anywhere.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { CHAINS, formatUnits, type PaymentRequired, type PaymentRequirements } from "@penstock/core";
import { HttpOneClick, buildDepositPayload, buildQuotePayload, depositInstructions, findQuotedEntry, isUnquoted, type DepositInstructions } from "@penstock/intents-adapter";
import { assertWithinCap } from "./cap";
import { readLiveEnv } from "./env";
import { solanaAddressOf } from "./keys";
import { SOLANA_USDC_MINT, findIncomingUsdc, solanaLamports, solanaUsdc } from "./rpc";
import { buildUsdcTransfer, sendAndConfirm } from "./solana";

const SOL = CHAINS.find((c) => c.key === "sol")!;
const DIR = join(process.cwd(), "data", "live-proof");
const STATE = join(DIR, "payment.json");
const RESUME_FOR_MS = 20 * 60_000;

interface State {
  status: "planned" | "sending" | "sent" | "paid" | "refunded" | "failed";
  url: string;
  createdAt: string;
  required: PaymentRequired;
  unquoted: PaymentRequirements;
  deposit: DepositInstructions;
  quotedUsd: number;
  txHash?: string;
  refundTest?: boolean;
  sentAmount?: string;
  sentAt?: string;
  result?: unknown;
}

const env = readLiveEnv();
const [cmd, ...rest] = process.argv.slice(2);
const save = (s: State) => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
};
const load = (): State | null => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as State) : null);
const die = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const usdc = (v: string | bigint) => formatUnits(BigInt(v), 6);

function payerChecks() {
  if (!env.payerAddress || !env.payerSecret) die("PAYER_SOLANA_ADDRESS and PAYER_SOLANA_PRIVATE_KEY must be set in .env");
  if (solanaAddressOf(env.payerSecret) !== env.payerAddress) die("PAYER_SOLANA_PRIVATE_KEY does not belong to PAYER_SOLANA_ADDRESS");
}

async function call(url: string, payload?: unknown): Promise<Response> {
  return fetch(url, { headers: payload ? { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload as never) } : {}, signal: AbortSignal.timeout(180_000) });
}

async function plan(url: string) {
  payerChecks();
  const prev = load();
  if (prev && (prev.status === "sending" || prev.status === "sent")) die(`a payment is already in flight (${prev.status}, tx ${prev.txHash ?? "?"}): run \`pnpm live:pay resume\``);
  const first = await call(url);
  if (first.status !== 402) die(`expected HTTP 402 from ${url}, got ${first.status}`);
  const required = decodePaymentRequiredHeader(first.headers.get("payment-required")!) as unknown as PaymentRequired;
  const unquoted = required.accepts.find((a) => isUnquoted(a) && a.network === SOL.caip2 && a.asset === SOLANA_USDC_MINT);
  if (!unquoted) die("the 402 has no near-intents entry for USDC on Solana");
  const quoteRes = await call(url, buildQuotePayload(required, unquoted!, env.payerAddress));
  const quotedBody = (await quoteRes.json().catch(() => null)) as PaymentRequired | null;
  if (quoteRes.status !== 402 || !quotedBody) die(`expected a quoted 402, got ${quoteRes.status}`);
  const quoted = findQuotedEntry(quotedBody!, unquoted!);
  if (!quoted) die(`no quoted entry: ${JSON.stringify(quotedBody).slice(0, 300)}`);
  const deposit = depositInstructions(quoted!);
  const quotedUsd = Number(usdc(deposit.amount)); // USDC in, so dollars ≈ amount
  assertWithinCap(quotedUsd, env.maxUsd);
  const dest = unquoted!.extra.destination as { amount: string; recipient: string };
  const s: State = { status: "planned", url, createdAt: new Date().toISOString(), required, unquoted: unquoted!, deposit, quotedUsd };
  save(s);
  const [lamports, bal] = await Promise.all([solanaLamports(env.solanaRpc, env.payerAddress), solanaUsdc(env.solanaRpc, env.payerAddress)]);
  console.log(`
EXACT PAYMENT (nothing has been sent)
  pay           ${usdc(deposit.amount)} USDC on Solana (mint ${SOLANA_USDC_MINT})
  from          ${env.payerAddress}  (holds ${usdc(bal)} USDC, ${formatUnits(lamports, 9)} SOL)
  to            ${deposit.payTo}  (single-use 1Click deposit address)
  seller gets   ${usdc(dest.amount)} USDC on NEAR to ${dest.recipient}
  route         Solana USDC -> NEAR Intents (1Click) -> NEAR USDC; quote signature verified by the proxy
  fees          ${usdc(BigInt(deposit.amount) - BigInt(dest.amount))} USDC (route fee plus the seller's one-time USDC storage registration)
  refund        to ${env.payerAddress} on Solana if the swap fails
  quote expires ${deposit.refundDeadline}
  cap           ${quotedUsd.toFixed(6)} USD <= LIVE_MAX_USD ${env.maxUsd}

To send it:  pnpm live:pay send --confirm ${deposit.payTo}
`);
}

async function send(confirm: string | undefined) {
  payerChecks();
  const s = load() ?? die("no planned payment: run `pnpm live:pay plan <url>` first");
  if (s.status !== "planned") die(`refusing to send: state is "${s.status}"${s.txHash ? ` (tx ${s.txHash})` : ""}; a payment is sent at most once`);
  if (confirm !== s.deposit.payTo) die(`refusing to send: --confirm must be the deposit address ${s.deposit.payTo}`);
  if (Date.parse(s.deposit.refundDeadline) - Date.now() < 90_000) die("the quote expires in under 90 s: plan again");
  assertWithinCap(s.quotedUsd, env.maxUsd);
  let amount = BigInt(s.deposit.amount);
  const refundTest = rest.includes("--refund-test-usdc");
  if (refundTest) {
    const want = BigInt(Math.round(Number(rest[rest.indexOf("--refund-test-usdc") + 1]) * 1e6));
    const q = (await new HttpOneClick({ baseUrl: env.oneClickBaseUrl, jwt: env.oneClickJwt || null }).status(s.deposit.payTo)).quoteResponse.quote;
    const min = BigInt(q.minAmountIn);
    const fee = BigInt(q.refundFee ?? "0");
    if (!(want > 0n) || want >= min) die(`refund test: ${usdc(want)} must be below minAmountIn ${usdc(min)}`);
    if (want < fee * 3n) die(`refund test: ${usdc(want)} must be at least 3x the refund fee ${usdc(fee)}`);
    assertWithinCap(Number(usdc(want)), env.maxUsd);
    console.log(`refund test: sending ${usdc(want)} USDC, below minAmountIn ${usdc(min)}; 1Click should refund it minus refundFee ${usdc(fee)}`);
    amount = want;
  }
  // The human approves a bound; a fresh quote above it is refused.
  const maxArg = rest[rest.indexOf("--max-usdc") + 1];
  if (rest.includes("--max-usdc")) {
    const bound = BigInt(Math.round(Number(maxArg) * 1e6));
    if (!(bound > 0n) || amount > bound) die(`refusing to send: ${usdc(amount)} USDC is above the approved --max-usdc ${maxArg}`);
  }
  const [bal, lamports] = await Promise.all([solanaUsdc(env.solanaRpc, env.payerAddress), solanaLamports(env.solanaRpc, env.payerAddress)]);
  if (bal < amount) die(`payer has ${usdc(bal)} USDC, needs ${usdc(amount)}`);
  if (lamports < 3_000_000n) die("payer has under 0.003 SOL for fees and token-account rent");

  const tx = await buildUsdcTransfer({ rpcUrl: env.solanaRpc, payerSecret: env.payerSecret, to: s.deposit.payTo, amount });
  // Recorded before broadcasting: if anything below crashes, `send` will refuse and only `resume` runs.
  save({ ...s, status: "sending", txHash: tx.signature, sentAt: new Date().toISOString(), refundTest, sentAmount: amount.toString() });
  console.log(`sending ${usdc(amount)} USDC: https://solscan.io/tx/${tx.signature}`);
  const r = await sendAndConfirm(env.solanaRpc, tx.raw, tx.signature, tx.blockhash, tx.lastValidBlockHeight).catch((e: Error) => {
    console.error(`  confirmation unclear: ${e.message.slice(0, 200)} (check the explorer; then \`pnpm live:pay resume\`)`);
    return "unclear" as const;
  });
  if (r === "failed") {
    save({ ...s, status: "failed", txHash: tx.signature, result: { solana: "transaction failed" } });
    die("the Solana transaction failed on chain (no USDC moved)");
  }
  save({ ...s, status: "sent", txHash: tx.signature, sentAt: new Date().toISOString(), refundTest, sentAmount: amount.toString() });
  console.log(`  ${r}`);
  await resume();
}

async function resume() {
  const s = load() ?? die("nothing to resume");
  if (s.status !== "sent" && s.status !== "sending") die(`nothing to resume (state "${s.status}")`);
  const payload = buildDepositPayload(s.required, s.unquoted, s.deposit, s.txHash!);
  const until = Date.now() + RESUME_FOR_MS;
  for (;;) {
    const res = await call(s.url, payload).catch((e: Error) => {
      console.log(`  proxy unreachable: ${e.message}; retrying`);
      return null;
    });
    if (res) {
      const pr = res.headers.get("payment-response");
      const settle = pr ? (decodePaymentResponseHeader(pr) as unknown as { success: boolean; errorReason?: string; transaction?: string; extra?: Record<string, unknown> }) : null;
      if (res.status === 200) {
        const receiptHeader = res.headers.get("penstock-receipt");
        const receipt = receiptHeader ? JSON.parse(Buffer.from(receiptHeader, "base64url").toString()) : null;
        const body = await res.text();
        const status = await new HttpOneClick({ baseUrl: env.oneClickBaseUrl, jwt: env.oneClickJwt || null }).status(s.deposit.payTo).catch(() => null);
        const result = { settle, receipt, oneClickStatus: status, responseBody: body.slice(0, 2000), finishedAt: new Date().toISOString() };
        save({ ...s, status: "paid", result });
        writeFileSync(join(DIR, `proof-${Date.now()}.json`), JSON.stringify({ ...s, status: "paid", result }, null, 2));
        console.log(`PAID: HTTP 200
  origin tx      https://solscan.io/tx/${s.txHash}
  NEAR delivery  ${settle?.transaction ? `https://nearblocks.io/txns/${settle.transaction}` : "?"}
  1Click status  ${status?.status ?? "?"}
  receipt        ${receipt ? `ed25519-signed, payment ${receipt.body?.paymentId ?? "?"}, simulated=${String(receipt.body?.simulated)}` : "missing"}
  recorded in    data/live-proof/`);
        return;
      }
      if (settle?.errorReason === "settlement_pending") console.log(`  pending (${String(settle.extra?.status ?? "?")}); retrying in 10 s`);
      else {
        const body = await res.text();
        const refunded = /refund/i.test(body) || /payment_failed|insufficient_deposit/.test(settle?.errorReason ?? "");
        const status = await new HttpOneClick({ baseUrl: env.oneClickBaseUrl, jwt: env.oneClickJwt || null }).status(s.deposit.payTo).catch(() => null);
        const refundTx = refunded ? await findIncomingUsdc(env.solanaRpc, env.payerAddress, s.deposit.payTo).catch(() => null) : null;
        const result = { httpStatus: res.status, settle, body: body.slice(0, 2000), oneClickStatus: status, refundTx, finishedAt: new Date().toISOString() };
        save({ ...s, status: refunded ? "refunded" : "failed", result });
        writeFileSync(join(DIR, `proof-${Date.now()}.json`), JSON.stringify({ ...s, status: refunded ? "refunded" : "failed", result }, null, 2));
        if (refunded && s.refundTest) {
          console.log(`REFUNDED (as intended): HTTP ${res.status}, ${settle?.errorReason ?? ""}
  deposit tx     https://solscan.io/tx/${s.txHash}
  1Click status  ${status?.status ?? "?"}; refunded ${status?.swapDetails.refundedAmount ?? "?"} (${status?.swapDetails.refundReason ?? "?"})
  refund tx      ${refundTx ? `https://solscan.io/tx/${refundTx}` : "not found yet (check the payer's history)"}
  recorded in    data/live-proof/`);
          return;
        }
        die(`proxy answered ${res.status}: ${settle?.errorReason ?? body.slice(0, 300)}`);
      }
    }
    if (Date.now() > until) die("still pending after 20 minutes; run `pnpm live:pay resume` again later (the payment is not resent)");
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

if (cmd === "plan") await plan(rest[0] ?? die("usage: pnpm live:pay plan <paid URL>"));
else if (cmd === "send") await send(rest[rest.indexOf("--confirm") + 1]);
else if (cmd === "resume") await resume();
else die("usage: pnpm live:pay plan <url> | send --confirm <deposit address> | resume");
