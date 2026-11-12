import { Journal, defaultJournalDir, PenstockBuyer, liveNearWallet, parseHoldings, simulatedNearWallet } from "@penstock/buyer-mcp";
import { log, type Endpoint, type PenstockConfig, type Seller } from "@penstock/core";
import type { Delivery, ProxyContext } from "./paywall";
import { buildTargetUrl, forward, validateUpstreamUrl } from "./upstream";

/**
 * Agent-to-agent resale: a Penstock seller whose endpoint lists `resaleOf` buys from those
 * upstream Penstock endpoints (paying them like any agent would, in USDC on NEAR from its own
 * account), then passes their results to its own composer upstream. What it paid is recorded as
 * `upstreamCost`, so the console shows the margin per call.
 *
 * demo/dry: the seller pays with a simulated NEAR wallet. live: RESALE_NEAR_KEY (a full-access key
 * of the seller's account) is required, and resale endpoints refuse payment until it is set.
 */

const MAX_DEPTH = 3;
export const RESALE_DEPTH_HEADER = "penstock-resale-depth";

export function resaleDelivery(base: Delivery, config: PenstockConfig, env: NodeJS.ProcessEnv = process.env): Delivery & { ready(endpoint: Endpoint): string | null } {
  const buyers = new Map<string, PenstockBuyer>();
  const buyerFor = (seller: Seller): PenstockBuyer => {
    let b = buyers.get(seller.id);
    if (!b) {
      const near = config.mode === "live" ? liveNearWallet(seller.nearAccount, String(env.RESALE_NEAR_KEY)) : simulatedNearWallet(seller.nearAccount);
      b = new PenstockBuyer({ directories: [], holdings: parseHoldings("near:USDC"), near, userAgent: `penstock-resale/${seller.id}`, autonomous: true, journal: new Journal({ dir: config.mode === "live" && defaultJournalDir() ? `${defaultJournalDir()}-resale-${seller.id}` : undefined }) });
      buyers.set(seller.id, b);
    }
    return b;
  };

  return {
    ready(endpoint) {
      if (!endpoint.resaleOf.length) return null;
      if (config.mode === "live" && !env.RESALE_NEAR_KEY) return "this resale endpoint is not ready: the seller has not configured RESALE_NEAR_KEY";
      return null;
    },

    async deliver(ctx: ProxyContext, endpoint, req, payment) {
      if (!endpoint.resaleOf.length) return base.deliver(ctx, endpoint, req, payment);
      const depth = Number(req.headers[RESALE_DEPTH_HEADER] ?? 0) || 0;
      if (depth >= MAX_DEPTH) throw new Error("resale chain too deep");
      const seller = ctx.store.getSeller(endpoint.sellerId)!;
      const buyer = buyerFor(seller);
      const ownUrl = `${ctx.config.publicUrl}/p/${seller.id}/${endpoint.slug}`;
      let cost = 0n;
      const upstream: { url: string; status: number; body: unknown }[] = [];
      const receipts: unknown[] = [];
      for (const u of endpoint.resaleOf) {
        if (u === ownUrl) throw new Error("an endpoint cannot resell itself");
        const v = validateUpstreamUrl(u, ctx.allowPrivateUpstreams);
        if (!v.ok) throw new Error(`resale upstream refused: ${v.reason}`);
        const r = await buyer.call(`${u}${req.search}`, { headers: { [RESALE_DEPTH_HEADER]: String(depth + 1) } });
        const receipt = r.receipt as { body?: { amountUsdc?: string } } | undefined;
        if (!r.paid || !receipt?.body?.amountUsdc) throw new Error(`upstream ${u} was not paid: ${r.note ?? r.status}`);
        cost += BigInt(receipt.body.amountUsdc);
        upstream.push({ url: u, status: r.status, body: r.body });
        receipts.push(receipt);
      }
      // A session-metered call is booked against the session's funding payment: accumulate, do not overwrite.
      const prior = payment.sessionId ? BigInt(ctx.store.getPayment(payment.id)?.upstreamCost ?? "0") : 0n;
      const priorReceipts = payment.sessionId ? (JSON.parse(ctx.store.getKv(`resale:${payment.id}`) ?? "[]") as unknown[]) : [];
      ctx.store.updatePayment(payment.id, { upstreamCost: (prior + cost).toString() });
      ctx.store.setKv(`resale:${payment.id}`, JSON.stringify([...priorReceipts, ...receipts]));
      log("info", "resale call composed", { endpoint: endpoint.id, upstreamCalls: upstream.length, upstreamCostUsdc: cost.toString() });
      const target = buildTargetUrl(endpoint, "", "");
      if (!target) throw new Error("invalid composer upstream");
      const query = Object.fromEntries(new URLSearchParams(req.search));
      return forward(target, "POST", { "content-type": "application/json" }, Buffer.from(JSON.stringify({ query, upstream })), { allowPrivate: ctx.allowPrivateUpstreams });
    },
  };
}
