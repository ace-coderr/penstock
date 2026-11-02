/**
 * `pnpm live:check`: preflight for the live proof (docs/LIVE-RUNBOOK.md). Reads .env and mainnet,
 * gets one real dry 1Click quote, and moves no funds.
 *
 * No seller key is needed. If the seller has no USDC storage yet, 1Click registers it on the first
 * delivery and charges the payer for it (quote.withdrawFee, docs/LIVE-RUNBOOK.md section 2).
 *
 * Secret values are never printed: the payer key is reported only as "matches the address".
 */
import { existsSync } from "node:fs";
import { formatUnits } from "@penstock/core";
import { HttpOneClick, OneClickError, parseRouteMinimum, type QuoteRequest } from "@penstock/intents-adapter";
import { assertWithinCap } from "./cap";
import { envLine, readLiveEnv } from "./env";
import { isSolanaAddress, solanaAddressOf } from "./keys";
import { NEAR_USDC, nearView, nearViewAccount, solanaLamports, solanaUsdc } from "./rpc";

const SOL_USDC_ASSET = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const NEAR_USDC_ASSET = `nep141:${NEAR_USDC}`;

const env = readLiveEnv();
const missing: { name: string; why: string }[] = [];
let failed = false;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => {
  failed = true;
  console.log(`  ✗ ${msg}`);
};
const note = (msg: string) => console.log(`  · ${msg}`);
const need = (name: string, why: string) => {
  missing.push({ name, why });
  bad(`${name} is empty (${why})`);
};
const near = (yocto: bigint | string) => formatUnits(BigInt(yocto), 24);

// A network failure (DNS, timeout, RPC down) ends the check as NOT READY with the reason, not a stack trace.
function networkFailure(e: unknown): never {
  const err = e as Error & { cause?: unknown };
  console.log(`  ✗ network error: ${err?.cause instanceof Error ? err.cause.message : (err?.message ?? String(e))}`);
  console.log("\nNOT READY (network)");
  process.exit(1);
}
process.on("unhandledRejection", networkFailure);
process.on("uncaughtException", networkFailure);

console.log("Penstock live preflight (moves no funds)\n");

console.log("Config");
if (!existsSync(".env")) bad(".env not found: copy .env.example to .env");
else ok(".env found (gitignored)");
note(`MODE=${env.mode}; spend cap LIVE_MAX_USD=${env.maxUsd}`);
if (env.oneClickJwt) ok("ONECLICK_JWT is set (value not shown)");
else note("ONECLICK_JWT is empty (optional: without it 1Click adds 0.25% per quote)");

console.log("\nSeller (NEAR)");
if (!env.sellerAccount) need("SELLER_NEAR_ACCOUNT", "the seller payout account");
else {
  const acct = await nearViewAccount(env.nearRpc, env.sellerAccount);
  if (!acct) bad(`${env.sellerAccount} does not exist on mainnet`);
  else {
    ok(`${env.sellerAccount} exists; balance ${near(acct.amount)} NEAR (none needed)`);
    const bounds = await nearView<{ min: string }>(env.nearRpc, NEAR_USDC, "storage_balance_bounds", {});
    const storage = await nearView<unknown>(env.nearRpc, NEAR_USDC, "storage_balance_of", { account_id: env.sellerAccount });
    if (storage) ok("USDC storage registered");
    else note(`USDC storage not registered yet (${near(bounds.min)} NEAR); 1Click registers it on the first delivery, see withdrawFee below`);
    const usdc = await nearView<string>(env.nearRpc, NEAR_USDC, "ft_balance_of", { account_id: env.sellerAccount });
    note(`USDC balance ${formatUnits(BigInt(usdc), 6)}`);
  }
}

console.log("\nPayer (Solana)");
if (!env.payerAddress) {
  need("PAYER_SOLANA_ADDRESS", "the payer wallet address, also the refund address");
  if (!env.payerSecret) need("PAYER_SOLANA_PRIVATE_KEY", "signs the deposit transfers");
} else if (!isSolanaAddress(env.payerAddress)) bad("PAYER_SOLANA_ADDRESS is not a base58 Solana address");
else {
  ok(`address ${env.payerAddress}`);
  if (!env.payerSecret) need("PAYER_SOLANA_PRIVATE_KEY", "signs the deposit transfers");
  else {
    const derived = solanaAddressOf(env.payerSecret);
    if (!derived) bad("PAYER_SOLANA_PRIVATE_KEY is not a base58 64-byte Solana secret key");
    else if (derived !== env.payerAddress) bad("PAYER_SOLANA_PRIVATE_KEY does not belong to PAYER_SOLANA_ADDRESS");
    else ok("PAYER_SOLANA_PRIVATE_KEY matches the address (value not shown)");
  }
  const [lamports, usdc] = await Promise.all([solanaLamports(env.solanaRpc, env.payerAddress), solanaUsdc(env.solanaRpc, env.payerAddress)]);
  note(`SOL ${formatUnits(lamports, 9)}; USDC ${formatUnits(usdc, 6)}`);
  if (lamports < 5_000_000n) bad("under 0.005 SOL: not enough for fees and a token-account rent");
  if (usdc === 0n) bad("no USDC on Solana");
}

console.log("\n1Click (real dry quote: USDC on Solana -> USDC on NEAR, nothing can be sent)");
if (env.sellerAccount && env.payerAddress && isSolanaAddress(env.payerAddress)) {
  const oc = new HttpOneClick({ baseUrl: env.oneClickBaseUrl, jwt: env.oneClickJwt || null });
  const base: QuoteRequest = {
    dry: true, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset: SOL_USDC_ASSET, depositType: "ORIGIN_CHAIN",
    destinationAsset: NEAR_USDC_ASSET, amount: "10000", refundTo: env.payerAddress, refundType: "ORIGIN_CHAIN",
    recipient: env.sellerAccount, recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  try {
    let q;
    try {
      q = await oc.quote(base);
    } catch (e) {
      const min = e instanceof OneClickError ? parseRouteMinimum(e.message) : null;
      if (min === null) throw e;
      note(`route minimum today: ${formatUnits(min, 6)} USDC delivered`);
      q = await oc.quote({ ...base, amount: min.toString() });
    }
    ok(`signature verified; pay ${q.quote.amountInFormatted} USDC on Solana (≈ $${Number(q.quote.amountInUsd).toFixed(4)}) -> ${q.quote.amountOutFormatted} USDC to ${env.sellerAccount}; refund fee ${formatUnits(BigInt(q.quote.refundFee ?? "0"), 6)} USDC; ~${q.quote.timeEstimate}s`);
    const wf = BigInt(q.quote.withdrawFee ?? "0");
    if (wf > 0n) note(`includes withdrawFee ${formatUnits(wf, 6)} USDC: 1Click's charge for registering ${env.sellerAccount}'s USDC storage on delivery`);
    try {
      assertWithinCap(Number(q.quote.amountInUsd), env.maxUsd);
      ok(`within the spend cap ($${env.maxUsd})`);
    } catch (e) {
      bad((e as Error).message);
    }
  } catch (e) {
    bad(`dry quote failed: ${(e as Error).message}`);
  }
} else note("skipped until SELLER_NEAR_ACCOUNT and PAYER_SOLANA_ADDRESS are set");

if (missing.length) {
  console.log("\nStill empty in .env (paste the value after the = sign; never commit .env):");
  for (const m of missing) console.log(`  ${m.name}  (line ${envLine(m.name) ?? "?"})  ${m.why}`);
}
console.log(failed ? "\nNOT READY" : "\nREADY");
process.exit(failed ? 1 : 0);
