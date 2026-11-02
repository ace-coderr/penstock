import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHAINS, DESTINATION, Store, assetOn, chainByKey, type PaymentRequirements } from "@penstock/core";
import {
  DryOneClick, HttpOneClick, NearIntentsMethod, OneClickError, RoutePlanner, SimulatedOneClick, TokenPricePricer,
  destinationHash, mintOperationToken, parseRouteMinimum, recordedTokens, verifyOperationToken, type KeyRing, type QuoteRequest,
} from "../src/index";

const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

/** A fetch stand-in that replays a recorded response and captures the request. */
function replay(status: number, body: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const recordedRequest = JSON.parse(fx("request-quote-dry-exact-output-arb-usdc.json")) as QuoteRequest;

describe("HttpOneClick against recorded 1Click responses (API 0.1.10)", () => {
  it("posts the documented QuoteRequest and parses the recorded dry quote", async () => {
    const { f, calls } = replay(201, fx("quote-dry-exact-output-arb-usdc.json"));
    const oc = new HttpOneClick({ baseUrl: "https://1click.example", jwt: "test-jwt", fetchImpl: f });
    const q = await oc.quote(recordedRequest);
    expect(q.quote).toMatchObject({ amountIn: "1010224", minAmountIn: "1000121", amountOut: "1000000", timeEstimate: 25 });
    expect(q.quote.depositAddress).toBeUndefined();
    expect(calls[0]!.url).toBe("https://1click.example/v0/quote");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("test-jwt");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    const sent = JSON.parse(String(calls[0]!.init.body));
    for (const k of ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"]) {
      expect(sent).toHaveProperty(k);
    }
  });

  it("parses the recorded SOL-origin dry quote", async () => {
    const { f } = replay(201, fx("quote-dry-exact-output-sol.json"));
    const q = await new HttpOneClick({ baseUrl: "https://x", fetchImpl: f }).quote(recordedRequest);
    expect(q.quote.amountOut).toBe("1000000");
    expect(Number(q.quote.amountInUsd)).toBeGreaterThan(1);
  });

  it("refuses a non-dry quote that came back without a deposit address", async () => {
    const { f } = replay(201, fx("quote-dry-exact-output-arb-usdc.json"));
    await expect(new HttpOneClick({ baseUrl: "https://x", fetchImpl: f }).quote({ ...recordedRequest, dry: false })).rejects.toThrow(/depositAddress/);
  });

  it("maps the recorded 401 (confidential quote without auth) and 404 (unknown deposit)", async () => {
    const r401 = replay(401, fx("quote-confidential-unauthenticated-401.json"));
    const err = await new HttpOneClick({ baseUrl: "https://x", fetchImpl: r401.f }).quote({ ...recordedRequest, confidentiality: "basic" }).catch((e) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/authentication is required/);
    const r404 = replay(404, fx("status-unknown-404.json"));
    const e2 = await new HttpOneClick({ baseUrl: "https://x", fetchImpl: r404.f }).status("0x0000000000000000000000000000000000000001").catch((e) => e);
    expect(e2.status).toBe(404);
  });

  it("rejects responses with a changed shape instead of trusting them", async () => {
    const bad = JSON.parse(fx("quote-dry-exact-output-arb-usdc.json"));
    bad.quote.amountIn = "1.01";
    const { f } = replay(201, JSON.stringify(bad));
    await expect(new HttpOneClick({ baseUrl: "https://x", fetchImpl: f }).quote(recordedRequest)).rejects.toThrow(/base-unit/);
    const { f: f2 } = replay(200, "<html>oops</html>");
    await expect(new HttpOneClick({ baseUrl: "https://x", fetchImpl: f2 }).tokens()).rejects.toThrow(/non-JSON/);
  });

  it("parses the recorded token list and finds NEAR USDC", async () => {
    const { f } = replay(200, fx("tokens.2026-11-01.json"));
    const tokens = await new HttpOneClick({ baseUrl: "https://x", fetchImpl: f }).tokens();
    expect(tokens.find((t) => t.assetId === DESTINATION.oneClickAssetId)?.decimals).toBe(6);
  });
});

describe("DryOneClick", () => {
  it("always sends dry:true upstream and attaches a simulated deposit address", async () => {
    const fresh = JSON.parse(fx("quote-dry-exact-output-arb-usdc.json"));
    fresh.quoteRequest.deadline = new Date(Date.now() + 300_000).toISOString();
    const { f, calls } = replay(201, JSON.stringify(fresh));
    // The recorded quote is edited (fresh deadline), so its 1Click signature no longer verifies.
    const dry = new DryOneClick(new HttpOneClick({ baseUrl: "https://x", fetchImpl: f, verifySignatures: false }));
    const tokens = replay(200, fx("tokens.2026-11-01.json"));
    (dry as unknown as { real: { tokens: () => Promise<unknown> } }).real.tokens = () => new HttpOneClick({ baseUrl: "https://x", fetchImpl: tokens.f }).tokens();
    const q = await dry.quote({ ...recordedRequest, dry: false, deadline: new Date(Date.now() + 300_000).toISOString() });
    expect(JSON.parse(String(calls[0]!.init.body)).dry).toBe(true);
    expect(q.quote.depositAddress!.startsWith("sim")).toBe(true);
    expect((await dry.status(q.quote.depositAddress!)).status).toBe("PENDING_DEPOSIT");
  });
});

describe("operationToken (draft section 'Operation Token')", () => {
  const ring: KeyRing = { currentKeyId: "k1", keys: new Map([["k1", Buffer.alloc(32, 7)]]) };
  const input = { network: "eip155:42161", depositAddress: "0x76b4c56085ED136a8744D52bE956396624a730E8", resource: "https://api.example.com/premium-data", destination: { network: "near:mainnet", asset: "usdc.near", amount: "1000000", recipient: "m.near" } };

  it("has the documented layout and a hex SHA-256 destination hash", () => {
    const t = mintOperationToken(ring, input, 1790244600);
    expect(t).toMatch(/^k1\.1790244600\.[A-Za-z0-9_-]{43}$/);
    expect(destinationHash(input.destination)).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyOperationToken(ring, t, input, 1790244000)).toEqual({ ok: true, expiry: 1790244600 });
  });

  it("binds network, deposit address, memo, resource and every destination term", () => {
    const t = mintOperationToken(ring, input, 1790244600);
    const variants = [
      { ...input, network: "eip155:8453" }, { ...input, depositAddress: input.depositAddress.toLowerCase() }, { ...input, depositMemo: "1" },
      { ...input, resource: "https://api.example.com/other" }, { ...input, destination: { ...input.destination, amount: "1" } },
      { ...input, destination: { ...input.destination, recipient: "attacker.near" } },
    ];
    for (const v of variants) expect(verifyOperationToken(ring, t, v, 1790244000).ok).toBe(false);
  });

  it("checks expiry first and rejects unknown keys and non-canonical encodings", () => {
    const t = mintOperationToken(ring, input, 1790244600);
    expect(verifyOperationToken(ring, t, input, 1790244601)).toEqual({ ok: false, reason: "invalid_exact_near_intents_token_expired" });
    expect(verifyOperationToken(ring, t.replace(/^k1/, "k9"), input, 1).ok).toBe(false);
    const last = t.at(-1)!;
    const sibling = t.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(verifyOperationToken(ring, sibling, input, 1).ok).toBe(false);
    expect(verifyOperationToken(ring, 42, input, 1).ok).toBe(false);
  });
});

describe("SimulatedOneClick follows the real API's validation and status machine", () => {
  const base: QuoteRequest = { ...recordedRequest, dry: false, deadline: new Date(Date.now() + 300_000).toISOString() };

  it("requires the documented fields and auth for confidential quotes", async () => {
    const sim = new SimulatedOneClick();
    await expect(sim.quote({ ...base, refundTo: "" })).rejects.toThrow(/refundTo/);
    await expect(sim.quote({ ...base, confidentiality: "basic" })).rejects.toMatchObject({ status: 401 });
    await expect(sim.quote({ ...base, originAsset: "nep141:nope" })).rejects.toMatchObject({ status: 400 });
  });

  it("walks PENDING_DEPOSIT -> PROCESSING -> SUCCESS with surplus refund", async () => {
    let now = 1_000_000;
    const sim = new SimulatedOneClick({ now: () => now, processingMs: 1000 });
    const q = await sim.quote({ ...base, deadline: new Date(now + 300_000).toISOString() });
    const addr = q.quote.depositAddress!;
    expect((await sim.status(addr)).status).toBe("PENDING_DEPOSIT");
    const tx = sim.deposit(addr, q.quote.amountIn);
    now += 500;
    expect((await sim.status(addr)).status).toBe("PROCESSING");
    now += 600;
    const s = await sim.status(addr);
    expect(s.status).toBe("SUCCESS");
    expect(s.swapDetails.originChainTxHashes.map((t) => t.hash)).toContain(tx);
    expect(BigInt(s.swapDetails.refundedAmount!)).toBe(BigInt(q.quote.amountIn) - BigInt(q.quote.minAmountIn));
  });

  it("refunds a partial deposit and a failed route to the payer", async () => {
    let now = 2_000_000;
    const sim = new SimulatedOneClick({ now: () => now, processingMs: 1000 });
    const q = await sim.quote({ ...base, deadline: new Date(now + 300_000).toISOString() });
    sim.deposit(q.quote.depositAddress!, "1");
    now += 2500;
    expect(await sim.status(q.quote.depositAddress!)).toMatchObject({ status: "REFUNDED", swapDetails: { refundReason: "PARTIAL_DEPOSIT", refundedAmount: "1" } });
    sim.failNextSwap();
    const q2 = await sim.quote({ ...base, deadline: new Date(now + 300_000).toISOString() });
    sim.deposit(q2.quote.depositAddress!, q2.quote.amountIn);
    now += 1500;
    expect((await sim.status(q2.quote.depositAddress!)).status).toBe("FAILED");
  });
});

describe("NearIntentsMethod", () => {
  const keys: KeyRing = { currentKeyId: "k1", keys: new Map([["k1", Buffer.alloc(32, 3)]]) };
  const seller = { id: "s", name: "S", nearAccount: "seller.near", description: "", origin: "", simulated: true };
  const endpoint = { id: "s.e", sellerId: "s", slug: "e", kind: "http" as const, description: "", capabilities: [], priceUsdc: "250000", upstreamUrl: "http://x", methods: ["GET"], sessionsEnabled: false, resaleOf: [] };
  const resource = { url: "http://p/p/s/e" };

  it("offers one unquoted entry per origin with vacant amount and payTo", async () => {
    const m = new NearIntentsMethod({ oneClick: new SimulatedOneClick(), keys, pricer: new TokenPricePricer(recordedTokens()), simulated: true });
    const offers = await m.offers(endpoint, seller, resource);
    expect(offers.length).toBe(CHAINS.reduce((n, c) => n + c.assets.length, 0) - 1);
    for (const o of offers) {
      expect(o).toMatchObject({ scheme: "exact", amount: "", payTo: "", extra: { assetTransferMethod: "near-intents", paymentFlow: "upfront", destination: { network: "near:mainnet", asset: DESTINATION.asset, amount: "250000", recipient: "seller.near" } } });
      expect(o.extra.indicativeAmount).toMatch(/^\d+$/);
    }
  });

  it("quotes, settles once, and returns the recorded result on replay", async () => {
    const sim = new SimulatedOneClick({ processingMs: 100 });
    const store = new Store(":memory:");
    const m = new NearIntentsMethod({ oneClick: sim, keys, pricer: new TokenPricePricer(recordedTokens()), simulated: true, pollIntervalMs: 20 });
    const req = (await m.offers(endpoint, seller, resource)).find((o) => o.network === "eip155:8453" && o.asset === assetOn(chainByKey("base")!, "USDC")!.x402Asset)!;
    const ctx = { store, now: Date.now };
    const meta = { endpoint, seller, buyer: "b1", resource };
    const quoted = await m.process({ x402Version: 2, resource, accepted: req, payload: { type: "quote", refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" } }, req, ctx, meta);
    expect(quoted.kind).toBe("quoted");
    const q = (quoted as { quoted: PaymentRequirements }).quoted;
    expect(q.payTo.startsWith("sim")).toBe(true);
    expect(q.extra.operationToken).toMatch(/^k1\./);
    const txHash = sim.deposit(q.payTo, q.amount);
    const deposit = { x402Version: 2, resource, accepted: req, payload: { type: "deposit", operationToken: q.extra.operationToken, depositAddress: q.payTo, txHash } };
    const settled = await m.process(deposit, req, ctx, meta);
    expect(settled.kind).toBe("settled");
    expect(settled).toMatchObject({ settle: { success: true, network: "near:mainnet", amount: "250000", extra: { originNetwork: "eip155:8453", originTxHash: txHash } } });
    const again = await m.process(deposit, req, ctx, meta);
    expect(again.kind).toBe("settled"); // recorded result returned unchanged; the paywall refuses to execute it twice
    const forged = await m.process({ ...deposit, payload: { ...deposit.payload, operationToken: String(q.extra.operationToken).slice(0, -2) + "xx" } }, req, ctx, meta);
    expect(forged).toMatchObject({ kind: "rejected", reason: "invalid_exact_near_intents_token_invalid" });
  });

  it("rejects a refundTo that is not valid on the origin chain", async () => {
    const m = new NearIntentsMethod({ oneClick: new SimulatedOneClick(), keys, pricer: new TokenPricePricer(recordedTokens()), simulated: true });
    const req = (await m.offers(endpoint, seller, resource)).find((o) => o.network.startsWith("solana"))!;
    const out = await m.process({ x402Version: 2, resource, accepted: req, payload: { type: "quote", refundTo: "0xnotsolana" } }, req, { store: new Store(":memory:"), now: Date.now }, { endpoint, seller, buyer: "b", resource });
    expect(out).toMatchObject({ kind: "rejected", reason: "invalid_payload" });
  });
});

describe("RoutePlanner", () => {
  it("ranks the buyer's holdings by USD spent and puts NEAR USDC first at zero fee", async () => {
    const routes = await new RoutePlanner(new SimulatedOneClick()).rank(
      [{ chain: "eth", symbol: "USDC" }, { chain: "base", symbol: "USDC" }, { chain: "near", symbol: "USDC" }, { chain: "sol", symbol: "SOL", balance: "1" }],
      400000n, "seller.near",
    );
    expect(routes[0]).toMatchObject({ chain: "near", method: "exact-near", feeUsd: 0 });
    expect(routes.find((r) => r.chain === "sol")).toMatchObject({ affordable: false });
    const base = routes.find((r) => r.chain === "base")!;
    const eth = routes.find((r) => r.chain === "eth")!;
    expect(base.amountInUsd).toBeLessThan(eth.amountInUsd);
    expect(base.timeEstimateSec).toBeGreaterThan(0);
  });

  it("reports each route's 1Click bridge minimum instead of failing opaquely", async () => {
    const routes = await new RoutePlanner(new SimulatedOneClick()).rank([{ chain: "btc", symbol: "BTC" }, { chain: "near", symbol: "wNEAR" }, { chain: "base", symbol: "USDC" }], 4000n, "seller.near");
    expect(routes.find((r) => r.chain === "btc")).toMatchObject({ minAmountOut: "6454605" });
    expect(routes.find((r) => r.chain === "base")!.error).toMatch(/route minimum of 0.14999 USDC: use a prepaid session/);
    expect(routes[0]).toMatchObject({ chain: "near", symbol: "wNEAR" });
    expect(routes[0]!.error).toBeUndefined();
  });

  it("parses the real 1Click minimum error", () => {
    expect(parseRouteMinimum("1Click HTTP 400: Amount is too low for bridge, try at least 149990")).toBe(149990n);
    expect(parseRouteMinimum("1Click HTTP 400: Internal server error")).toBeNull();
  });
});
