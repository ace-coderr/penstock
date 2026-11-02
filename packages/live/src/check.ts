/**
 * `pnpm live:check`: preflight for the live proof (docs/LIVE-RUNBOOK.md). Reads .env and mainnet,
 * gets one real dry 1Click quote, and moves no funds.
 *
 * `pnpm live:check --register --confirm <seller account>` also sends the seller's USDC storage
 * registration (0.00125 NEAR plus gas), once, after a human has approved it.
 *
 * Secret values are never printed: keys are reported only as "matches" or by their public key.
 */
import { existsSync } from "node:fs";
import { formatUnits } from "@penstock/core";
import { HttpOneClick, OneClickError, parseRouteMinimum, type QuoteRequest } from "@penstock/intents-adapter";
import { assertWithinCap } from "./cap";
import { envLine, readLiveEnv } from "./env";
import { isSolanaAddress, nearPublicKeyOf, solanaAddressOf } from "./keys";
import { registerUsdcStorage } from "./register";
import { NEAR_USDC, nearAccessKey, nearView, nearViewAccount, solanaLamports, solanaUsdc } from "./rpc";

const SOL_USDC_ASSET = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const NEAR_USDC_ASSET = `nep141:${NEAR_USDC}`;
/** NEAR kept back for gas when deciding whether the seller can pay for registration. */
const GAS_RESERVE_YOCTO = 3_000_000_000_000_000_000_000n; // 0.003 NEAR

const args = process.argv.slice(2);
const wantRegister = args.includes("--register");
const confirm = args[args.indexOf("--confirm") + 1];

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

console.log(`Penstock live preflight (moves no funds${wantRegister ? ", except the storage registration you asked for" : ""})\n`);

console.log("Config");
if (!existsSync(".env")) bad(".env not found: copy .env.example to .env");
else ok(".env found (gitignored)");
note(`MODE=${env.mode}; spend cap LIVE_MAX_USD=${env.maxUsd}`);
if (env.oneClickJwt) ok("ONECLICK_JWT is set (value not shown)");
else note("ONECLICK_JWT is empty (optional: without it 1Click adds 0.25% per quote)");

console.log("\nSeller (NEAR)");
let sellerYocto = 0n;
let storage: unknown = undefined;
let bounds: { min: string } | null = null;
let sellerKeyOk = false;
if (!env.sellerAccount) need("SELLER_NEAR_ACCOUNT", "the seller payout account");
else {
  const acct = await nearViewAccount(env.nearRpc, env.sellerAccount);
  if (!acct) bad(`${env.sellerAccount} does not exist on mainnet`);
  else {
    sellerYocto = BigInt(acct.amount);
    ok(`${env.sellerAccount} exists; balance ${near(sellerYocto)} NEAR`);
    bounds = await nearView<{ min: string }>(env.nearRpc, NEAR_USDC, "storage_balance_bounds", {});
    storage = await nearView<unknown>(env.nearRpc, NEAR_USDC, "storage_balance_of", { account_id: env.sellerAccount });
    if (storage) ok("USDC storage registered");
    else bad(`USDC storage NOT registered (needs ${near(bounds.min)} NEAR deposit plus gas)`);
    const usdc = await nearView<string>(env.nearRpc, NEAR_USDC, "ft_balance_of", { account_id: env.sellerAccount });
    note(`USDC balance ${formatUnits(BigInt(usdc), 6)}`);
    const wnear = await nearView<string>(env.nearRpc, "wrap.near", "ft_balance_of", { account_id: env.sellerAccount }).catch(() => "0");
    if (BigInt(wnear) > 0n) note(`wNEAR balance ${near(wnear)} (tokens, not gas)`);
  }
  if (!env.sellerSecret) {
    if (!storage) need("SELLER_NEAR_PRIVATE_KEY", "signs the one USDC storage registration");
    else note("SELLER_NEAR_PRIVATE_KEY is empty (not needed: storage is registered)");
  } else {
    const pub = nearPublicKeyOf(env.sellerSecret);
    if (!pub) bad("SELLER_NEAR_PRIVATE_KEY is not a valid ed25519:... key");
    else {
      const key = await nearAccessKey(env.nearRpc, env.sellerAccount, pub);
      sellerKeyOk = !!key && key.permission === "FullAccess";
      if (sellerKeyOk) ok(`SELLER_NEAR_PRIVATE_KEY is a full-access key of ${env.sellerAccount} (public key ${pub})`);
      else bad(`SELLER_NEAR_PRIVATE_KEY (public key ${pub}) is not a full-access key of ${env.sellerAccount}`);
    }
  }
}

console.log("\nPayer (Solana)");
let payerOk = false;
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
    else {
      payerOk = true;
      ok("PAYER_SOLANA_PRIVATE_KEY matches the address (value not shown)");
    }
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

if (wantRegister) {
  console.log("\nUSDC storage registration");
  const deposit = BigInt(bounds?.min ?? "0");
  if (confirm !== env.sellerAccount) bad(`refusing: pass --confirm ${env.sellerAccount || "<seller account>"} to register`);
  else if (storage) note("already registered; nothing to do");
  else if (!sellerKeyOk || !bounds) bad("refusing: the seller key check above did not pass");
  else if (sellerYocto < deposit + GAS_RESERVE_YOCTO) bad(`refusing: ${env.sellerAccount} has ${near(sellerYocto)} NEAR, needs at least ${near(deposit + GAS_RESERVE_YOCTO)} (fund it first, runbook section 3)`);
  else {
    note(`sending storage_deposit({ account_id: "${env.sellerAccount}", registration_only: true }) with ${near(deposit)} NEAR to ${NEAR_USDC}`);
    const r = await registerUsdcStorage({ nearRpc: env.nearRpc, accountId: env.sellerAccount, secret: env.sellerSecret, depositYocto: deposit });
    if (r.ok) ok(`registered: https://nearblocks.io/txns/${r.hash}`);
    else bad(`transaction ${r.hash} failed: ${JSON.stringify(r.failure).slice(0, 200)}`);
  }
}

if (missing.length) {
  console.log("\nStill empty in .env (paste the value after the = sign; never commit .env):");
  for (const m of missing) console.log(`  ${m.name}  (line ${envLine(m.name) ?? "?"})  ${m.why}`);
}
if (!payerOk && !missing.some((m) => m.name.startsWith("PAYER"))) note("payer key not verified");
console.log(failed ? "\nNOT READY" : "\nREADY");
process.exit(failed ? 1 : 0);
