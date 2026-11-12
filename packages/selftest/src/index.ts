import { decodePaymentRequiredHeader } from "@x402/core/http";
import { verifyReceipt, type PaymentRequired } from "@penstock/core";
import { Journal, PenstockBuyer, liveNearWallet, parseHoldings, simulatedNearWallet, simulatedOriginWallet } from "@penstock/buyer-mcp";
import { HttpOneClick, isUnquoted, type RankedRoute } from "@penstock/intents-adapter";

/**
 * `pnpm selftest <url>`: calls a paywalled endpoint the way an agent would and reports each step
 * as pass/fail with the reason.
 *   simulated target (demo/dry): pays with simulated wallets end to end.
 *   live target: proves a real 1Click dry quote for the cheapest route (no funds move); with
 *   --pay and PENSTOCK_NEAR_ACCOUNT/PENSTOCK_NEAR_KEY it pays a tiny amount in USDC on NEAR.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

export interface SelftestOptions {
  url: string;
  holdings?: string;
  pay?: boolean;
  maxUsd?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface SelftestResult {
  pass: boolean;
  mode: "simulated" | "live" | "unknown";
  checks: Check[];
}

export async function runSelftest(o: SelftestOptions): Promise<SelftestResult> {
  const f = o.fetchImpl ?? fetch;
  const env = o.env ?? process.env;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, skipped = false) => checks.push({ name, ok, detail, skipped });
  let url: URL;
  try {
    url = new URL(o.url);
  } catch {
    add("URL", false, `not a valid URL: ${o.url}`);
    return { pass: false, mode: "unknown", checks };
  }

  // 1. Unpaid call must be refused with an x402 v2 402.
  let required: PaymentRequired | null = null;
  try {
    const r = await f(url, { signal: AbortSignal.timeout(15_000) });
    const h = r.headers.get("payment-required");
    if (r.status !== 402) add("Unpaid call returns 402", false, `got HTTP ${r.status}; the endpoint is not paywalled`);
    else if (!h) add("Unpaid call returns 402", false, "402 without a PAYMENT-REQUIRED header");
    else {
      required = decodePaymentRequiredHeader(h) as PaymentRequired;
      const ok = required.x402Version === 2 && Array.isArray(required.accepts) && required.accepts.length > 0;
      add("Unpaid call returns 402", ok, ok ? `x402 v2, ${required.accepts.length} payment options` : "PAYMENT-REQUIRED is not a valid x402 v2 object");
    }
  } catch (e) {
    add("Unpaid call returns 402", false, `request failed: ${(e as Error).message}. Is the proxy running (pnpm demo)?`);
  }
  if (!required) return { pass: false, mode: "unknown", checks };

  const exact = required.accepts.find((a) => a.scheme === "exact" && a.network.startsWith("near:") && !a.extra?.assetTransferMethod);
  const origins = required.accepts.filter(isUnquoted);
  add("Accepts USDC on NEAR (exact)", !!exact, exact ? `pays ${exact.payTo} ${Number(exact.amount) / 1e6} USDC directly` : "no exact NEAR option");
  add("Accepts any chain (near-intents)", origins.length > 0, origins.length ? `${new Set(origins.map((a) => a.network)).size} origin chains, ${origins.length} assets` : "no near-intents options");

  // 2. Discovery and mode.
  let simulated: boolean | null = null;
  try {
    const d = (await (await f(`${url.origin}/.well-known/penstock.json`, { signal: AbortSignal.timeout(10_000) })).json()) as { simulated?: boolean; mode?: string; sellers?: unknown[] };
    simulated = d.simulated ?? null;
    add("Discovery document", Array.isArray(d.sellers), `mode ${d.mode ?? "?"}${d.simulated ? " (simulated)" : ""}, ${d.sellers?.length ?? 0} sellers`);
  } catch {
    add("Discovery document", true, "no /.well-known/penstock.json (not a Penstock proxy?)", true);
  }

  const holdings = parseHoldings(o.holdings ?? env.PENSTOCK_HOLDINGS ?? "base:USDC:5000000,sol:SOL:50000000");

  // 3a. Simulated target: pay end to end with simulated wallets.
  if (simulated !== false) {
    const buyer = new PenstockBuyer({
      directories: [`${url.origin}/.well-known/penstock.json`], holdings, near: simulatedNearWallet("selftest-agent.near"),
      origins: holdings.filter((h) => h.chain !== "near").map((h) => simulatedOriginWallet(h.chain, url.origin)), fetchImpl: f, journal: new Journal(), // simulated target: ephemeral
    });
    try {
      const routes: RankedRoute[] = await buyer.routes(url.href);
      const best = routes.find((r) => !r.error);
      const viaSession = routes.filter((r) => r.minAmountOut).sort((x, y) => Number(BigInt(x.minAmountOut!) - BigInt(y.minAmountOut!)))[0];
      add("Cheapest route quoted", !!(best || viaSession), best
        ? `${best.symbol} on ${best.chainLabel}: pay ${best.amountInFormatted} ${best.symbol} (≈$${best.amountInUsd.toFixed(6)}), fee $${best.feeUsd.toFixed(6)}, ~${best.timeEstimateSec}s [${best.source}]`
        : viaSession ? `price is below every 1Click bridge minimum; smallest is ${viaSession.symbol} on ${viaSession.chainLabel} at $${Number(viaSession.minAmountOut) / 1e6}, so a prepaid session is funded [${viaSession.source}]` : "no route");
    } catch (e) {
      add("Cheapest route quoted", false, (e as Error).message);
    }
    const r = await buyer.call(url.href, {}, o.maxUsd);
    add("Paid and got the resource", r.paid && r.status === 200, r.paid ? `HTTP 200 via ${r.method} from ${r.originSymbol} on ${r.originChain}${r.method === "session" ? ` (${r.note})` : ""} [simulated]` : `HTTP ${r.status}: ${r.note ?? JSON.stringify(r.body).slice(0, 160)}`);
    add("Settlement reported", !!r.settlement?.success, r.settlement ? `PAYMENT-RESPONSE success=${r.settlement.success} network=${r.settlement.network} tx=${r.settlement.transaction.slice(0, 24)}…` : "no PAYMENT-RESPONSE header");
    const receipt = r.receipt as Parameters<typeof verifyReceipt>[0] | undefined;
    add("Signed receipt verifies", !!receipt && verifyReceipt(receipt), receipt ? `ed25519 over ${Object.keys(receipt.body).length} fields` : "no PENSTOCK-RECEIPT header");
    return { pass: checks.every((c) => c.ok), mode: "simulated", checks };
  }

  // 3b. Live target: real 1Click dry quote (no funds), optional tiny real payment.
  const dest = (origins[0]?.extra?.destination ?? null) as { amount: string; recipient: string } | null;
  if (dest && origins.length) {
    try {
      const { RoutePlanner } = await import("@penstock/intents-adapter");
      const planner = new RoutePlanner(new HttpOneClick({ baseUrl: env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com", jwt: env.ONECLICK_JWT ?? null, fetchImpl: f }));
      const ranked = await planner.rank(holdings, BigInt(dest.amount), dest.recipient);
      const best = ranked.find((x) => !x.error);
      add("Real 1Click dry quote", !!best, best ? `${best.symbol} on ${best.chainLabel}: ${best.amountInFormatted} ${best.symbol}, fee $${best.feeUsd.toFixed(6)}, ~${best.timeEstimateSec}s. No funds moved.` : `no route: ${ranked[0]?.error ?? "unknown"}`);
    } catch (e) {
      add("Real 1Click dry quote", false, (e as Error).message);
    }
  }
  if (!o.pay) {
    add("Real payment", true, "skipped (add --pay with PENSTOCK_NEAR_ACCOUNT and PENSTOCK_NEAR_KEY to pay a tiny amount in USDC on NEAR)", true);
  } else if (!env.PENSTOCK_NEAR_ACCOUNT || !env.PENSTOCK_NEAR_KEY) {
    add("Real payment", false, "--pay needs PENSTOCK_NEAR_ACCOUNT and PENSTOCK_NEAR_KEY");
  } else if (!exact || Number(exact.amount) > (o.maxUsd ?? 0.05) * 1e6) {
    add("Real payment", false, `refusing: price ${exact ? Number(exact.amount) / 1e6 : "?"} USDC is above the tiny-amount ceiling $${o.maxUsd ?? 0.05}`);
  } else {
    const buyer = new PenstockBuyer({ directories: [], holdings: parseHoldings("near:USDC"), near: liveNearWallet(env.PENSTOCK_NEAR_ACCOUNT, env.PENSTOCK_NEAR_KEY), fetchImpl: f });
    const r = await buyer.call(url.href, {}, o.maxUsd ?? 0.05);
    add("Real payment", r.paid, r.paid ? `paid ${Number(exact.amount) / 1e6} USDC on NEAR, tx ${r.settlement?.transaction}` : `HTTP ${r.status}: ${r.note ?? JSON.stringify(r.body).slice(0, 160)}`);
  }
  return { pass: checks.every((c) => c.ok), mode: "live", checks };
}

export function formatReport(r: SelftestResult, url: string): string {
  const lines = [`penstock selftest  ${url}  (${r.mode})`, ""];
  for (const c of r.checks) lines.push(`  ${c.skipped ? "–" : c.ok ? "✓" : "✗"} ${c.name.padEnd(34)} ${c.detail}`);
  lines.push("", r.pass ? "PASS" : `FAIL: ${r.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`);
  return lines.join("\n");
}
