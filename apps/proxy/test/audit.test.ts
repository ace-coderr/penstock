import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "node:http";
import { loadConfig, Store } from "@penstock/core";
import { buildExactPayload, isExactNear, simulatedNearWallet } from "@penstock/buyer-mcp";
import { NearIntentsMethod, SimulatedOneClick, TokenPricePricer, buildQuotePayload, findQuotedEntry, isUnquoted, recordedTokens } from "@penstock/intents-adapter";
import { validateUpstreamUrl } from "../src/upstream";
import { get402, paidInit, startHarness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.stop());

function raw(path: string, method: string, headers: Record<string, string>, body = ""): Promise<{ status: number; body: string }> {
  const u = new URL(h.base);
  return new Promise((resolve, reject) => {
    const r = request({ host: u.hostname, port: u.port, path, method, headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c)).on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

describe("audit: replay and double settlement", () => {
  it("settles exactly once when the same signed payment is sent concurrently", async () => {
    const url = `${h.base}/p/tidewater/geocode?q=lagos`;
    const { required } = await get402(url);
    const payload = await buildExactPayload(simulatedNearWallet("racer.near"), required, required.accepts.find(isExactNear)!);
    const statuses = await Promise.all(Array.from({ length: 6 }, () => fetch(url, paidInit(payload)).then((r) => r.status)));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(h.proxy.store.listPayments({ limit: 50 }).filter((p) => p.payer === "racer.near")).toHaveLength(1);
  });

  it("does not let a session-opening payment open a second session", async () => {
    const url = `${h.base}/s/tidewater/tides/open/20000`;
    const { required } = await get402(url);
    const payload = await buildExactPayload(simulatedNearWallet("opener.near"), required, required.accepts.find(isExactNear)!);
    expect((await fetch(url, paidInit(payload))).status).toBe(200);
    expect((await fetch(url, paidInit(payload))).status).toBe(402);
  });
});

describe("audit: price tampering on near-intents", () => {
  it("quotes the server's destination terms even if the client edits accepted.extra.destination", async () => {
    const url = `${h.base}/p/tidewater/voyage-plan?harbor=lagos`;
    const { required } = await get402(url);
    const real = required.accepts.find((a) => isUnquoted(a) && a.network === "eip155:42161" && a.asset === "0xaf88d065e77c8cc2239327c5edb3a432268e5831")!;
    const forged = { ...real, extra: { ...real.extra, destination: { ...(real.extra.destination as object), amount: "1", recipient: "attacker.near" } } };
    const res = await fetch(url, paidInit(buildQuotePayload(required, forged, "0x2527D02599Ba641c19FEa793cD0F167589a0f10D")));
    const second = (await res.json()) as typeof required;
    const quoted = findQuotedEntry(second, real)!;
    expect(quoted.extra.destination).toMatchObject({ amount: "250000", recipient: "tidewater-data.near" });
  });
});

describe("audit: quote expiry race", () => {
  it("a deposit that lands after the refund deadline is refunded, not swapped, and booked as a refund", async () => {
    let now = 5_000_000_000;
    const sim = new SimulatedOneClick({ now: () => now, processingMs: 100 });
    const store = new Store(":memory:");
    const keys = { currentKeyId: "k1", keys: new Map([["k1", Buffer.alloc(32, 9)]]) };
    const m = new NearIntentsMethod({ oneClick: sim, keys, pricer: new TokenPricePricer(recordedTokens()), simulated: true, pollIntervalMs: 1, settleWindowMs: 50 });
    const seller = { id: "s", name: "S", nearAccount: "s.near", description: "", origin: "", simulated: true };
    const endpoint = { id: "s.e", sellerId: "s", slug: "e", kind: "http" as const, description: "", capabilities: [], priceUsdc: "250000", upstreamUrl: "http://x", methods: ["GET"], sessionsEnabled: false, resaleOf: [] };
    const resource = { url: "http://p/p/s/e" };
    const req = (await m.offers(endpoint, seller, resource)).find((o) => o.network === "eip155:8453" && o.asset.startsWith("0x8335"))!;
    const ctx = { store, now: () => now };
    const meta = { endpoint, seller, buyer: "b", resource };
    const q = await m.process({ x402Version: 2, resource, accepted: req, payload: { type: "quote", refundTo: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" } }, req, ctx, meta);
    const quoted = (q as unknown as { quoted: { payTo: string; amount: string; extra: { operationToken: string } } }).quoted;
    now += (req.maxTimeoutSeconds + 5) * 1000; // past refundDeadline, still inside the token's 24 h grace
    const txHash = sim.deposit(quoted.payTo, quoted.amount);
    now += 1000;
    const out = await m.process({ x402Version: 2, resource, accepted: req, payload: { type: "deposit", operationToken: quoted.extra.operationToken, depositAddress: quoted.payTo, txHash } }, req, ctx, meta);
    expect(out).toMatchObject({ kind: "rejected", reason: "exact_near_intents_payment_failed", refund: { refundReason: "DEADLINE_PASSED" } });
  });
});

describe("audit: SSRF and open proxy", () => {
  it("refuses upstreams that point back at the proxy itself", () => {
    expect(validateUpstreamUrl("http://127.0.0.1:4020/api/admin/overview", true, [4020]).ok).toBe(false);
    expect(validateUpstreamUrl("http://localhost:4020/x", true, [4020]).ok).toBe(false);
    expect(validateUpstreamUrl("http://127.0.0.1:4030/tides", true, [4020]).ok).toBe(true);
  });

  it("only forwards to configured upstreams: an absolute URL in the path stays under the upstream", async () => {
    const r = await fetch(`${h.base}/p/tidewater/tides/http:%2f%2fevil.example%2f`);
    expect([400, 402]).toContain(r.status);
  });
});

describe("audit: admin API hardening", () => {
  it("refuses non-JSON writes (cross-site form/text POST)", async () => {
    const r = await raw("/api/admin/endpoints", "POST", { host: "127.0.0.1", "content-type": "text/plain" }, JSON.stringify({ slug: "csrf", upstreamUrl: "https://example.com", priceUsd: "0.01" }));
    expect(r.status).toBe(415);
  });

  it("refuses token-less access with a foreign Host header (DNS rebinding) or through a forwarding proxy", async () => {
    expect((await raw("/api/admin/overview", "GET", { host: "attacker.example" })).status).toBe(401);
    expect((await raw("/api/admin/overview", "GET", { host: "localhost", "x-forwarded-for": "203.0.113.9" })).status).toBe(401);
    expect((await raw("/api/admin/overview", "GET", { host: "localhost" })).status).toBe(200);
  });
});

describe("audit: MCP passthrough", () => {
  it("does not forward unpaid non-tool methods such as resources/read", async () => {
    const r = await fetch(`${h.base}/p/tidewater/summarize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "x" } }) });
    const body = (await r.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32601);
  });
});

describe("audit: configuration", () => {
  it("binds demo and dry to loopback by default and validates the token key id", () => {
    expect(loadConfig({ MODE: "demo" }).host).toBe("127.0.0.1");
    expect(loadConfig({ MODE: "dry" }).host).toBe("127.0.0.1");
    expect(() => loadConfig({ MODE: "demo", OPERATION_TOKEN_KEY_ID: "a.b" })).toThrow(/KEY_ID/);
    expect(() => loadConfig({ MODE: "live", OPERATION_TOKEN_SECRET: "ab".repeat(32), SELLER_NEAR_ACCOUNT: "s.near" })).toThrow(/ADMIN_TOKEN/);
  });

  it("never echoes the operation token into receipts or settlement headers", async () => {
    const receipts = h.proxy.store.listPayments({ limit: 100 }).map((p) => h.proxy.store.getKv(`receipt:${p.id}`) ?? "").join("");
    expect(receipts).not.toMatch(/k1\.\d{10}\./);
  });
});
