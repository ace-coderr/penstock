import { describe, expect, it } from "vitest";
import type { Endpoint } from "@penstock/core";
import { buildTargetUrl, filterRequestHeaders, forward, isBlockedAddress, validateUpstreamUrl } from "../src/upstream";

const ep = (upstreamUrl: string): Endpoint => ({ id: "s.e", sellerId: "s", slug: "e", kind: "http", description: "", capabilities: [], priceUsdc: "1", upstreamUrl, methods: ["GET"], sessionsEnabled: false, resaleOf: [] });

describe("upstream guards", () => {
  it("blocks metadata and private ranges (private only outside demo)", () => {
    expect(isBlockedAddress("169.254.169.254", true)).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254", true)).toBe(true);
    expect(isBlockedAddress("10.1.2.3", false)).toBe(true);
    expect(isBlockedAddress("127.0.0.1", false)).toBe(true);
    expect(isBlockedAddress("127.0.0.1", true)).toBe(false);
    expect(isBlockedAddress("93.184.215.14", false)).toBe(false);
  });

  it("validates seller-registered upstream URLs", () => {
    expect(validateUpstreamUrl("https://api.example.com/v1", false).ok).toBe(true);
    expect(validateUpstreamUrl("http://api.example.com/v1", false).ok).toBe(false);
    expect(validateUpstreamUrl("https://user:pw@api.example.com", false).ok).toBe(false);
    expect(validateUpstreamUrl("file:///etc/passwd", true).ok).toBe(false);
    expect(validateUpstreamUrl("http://169.254.169.254/latest", true).ok).toBe(false);
    expect(validateUpstreamUrl("https://localhost/x", false).ok).toBe(false);
  });

  it("keeps the target under the configured upstream path and origin", () => {
    const e = ep("https://api.example.com/v1/tides");
    expect(buildTargetUrl(e, "/today", "?a=1")!.href).toBe("https://api.example.com/v1/tides/today?a=1");
    expect(buildTargetUrl(e, "/../admin", "")).toBeNull();
    expect(buildTargetUrl(e, "/..%2fadmin", "")).toBeNull();
    expect(buildTargetUrl(e, "/%2e%2e/admin", "")).toBeNull();
    expect(buildTargetUrl(e, "/a\\b", "")).toBeNull();
    expect(buildTargetUrl(e, "//evil.com/x", "")!.origin).toBe("https://api.example.com");
  });

  it("forwards only an allowlist of request headers and drops CR/LF", () => {
    const out = filterRequestHeaders({ "content-type": "application/json", cookie: "a=b", authorization: "Bearer x", "payment-signature": "zzz", "user-agent": "bad\r\nX-Injected: 1" });
    expect(out).toEqual({ "content-type": "application/json" });
  });

  it("refuses to connect to a hostname that resolves to a private address in live mode", async () => {
    await expect(forward(new URL("http://localhost:9/"), "GET", {}, null, { allowPrivate: false, timeoutMs: 2000 })).rejects.toThrow(/not allowed/);
  });
});
