import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, BlockList } from "node:net";
import type { Endpoint } from "@penstock/core";

/**
 * Forwarding to a seller's upstream. The upstream URL comes only from the seller's endpoint
 * config; the request can add a sub-path and query, nothing else. Private and metadata addresses
 * are refused at connect time (custom DNS lookup), which also defeats DNS rebinding.
 */

const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet("169.254.0.0", 16, "ipv4"); // link-local incl. cloud metadata
ALWAYS_BLOCKED.addSubnet("0.0.0.0", 8, "ipv4");
ALWAYS_BLOCKED.addSubnet("224.0.0.0", 4, "ipv4");
ALWAYS_BLOCKED.addSubnet("fe80::", 10, "ipv6");
ALWAYS_BLOCKED.addAddress("::", "ipv6");

const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addAddress("::1", "ipv6");

export function isBlockedAddress(address: string, allowPrivate: boolean): boolean {
  let addr = address;
  let family: "ipv4" | "ipv6" = isIP(addr) === 6 ? "ipv6" : "ipv4";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) { addr = mapped[1]!; family = "ipv4"; }
  if (ALWAYS_BLOCKED.check(addr, family)) return true;
  return !allowPrivate && PRIVATE.check(addr, family);
}

/** Validates an upstream URL when a seller registers it. */
export function validateUpstreamUrl(raw: string, allowPrivate: boolean): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "only http and https upstreams are allowed" };
  if (!allowPrivate && url.protocol !== "https:") return { ok: false, reason: "upstreams must use https in live mode" };
  if (url.username || url.password) return { ok: false, reason: "credentials in upstream URLs are not allowed" };
  if (url.hash) return { ok: false, reason: "fragments are not allowed" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host, allowPrivate)) return { ok: false, reason: "upstream address is not allowed" };
  if (!allowPrivate && /^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(host)) return { ok: false, reason: "internal hostnames are not allowed in live mode" };
  return { ok: true, url };
}

/**
 * Builds the target URL from the endpoint's upstream and the caller's sub-path. The sub-path is
 * decoded once and rejected if it contains traversal, encoded separators or control characters.
 */
export function buildTargetUrl(endpoint: Endpoint, subPath: string, search: string): URL | null {
  const base = new URL(endpoint.upstreamUrl);
  let decoded: string;
  try {
    decoded = decodeURIComponent(subPath);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(decoded) || /%2f|%5c|%2e/i.test(subPath)) return null;
  const segments = decoded.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === "..")) return null;
  const basePath = base.pathname.replace(/\/+$/, "");
  const target = new URL(base.origin);
  target.pathname = segments.length ? `${basePath}/${segments.map(encodeURIComponent).join("/")}` : basePath || "/";
  target.search = search.length > 2048 ? "" : search;
  if (target.origin !== base.origin || !target.pathname.startsWith(basePath)) return null;
  return target;
}

const FORWARD_REQUEST_HEADERS = new Set(["accept", "accept-language", "content-type", "user-agent"]);
const FORWARD_RESPONSE_HEADERS = new Set(["content-type", "cache-control", "content-language", "etag", "last-modified"]);

export interface UpstreamResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ForwardOptions {
  allowPrivate: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export function filterRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!FORWARD_REQUEST_HEADERS.has(k.toLowerCase()) || v === undefined) continue;
    const value = Array.isArray(v) ? v.join(", ") : v;
    if (/[\r\n]/.test(value)) continue;
    out[k.toLowerCase()] = value;
  }
  return out;
}

export function forward(target: URL, method: string, headers: Record<string, string>, body: Buffer | null, opts: ForwardOptions): Promise<UpstreamResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const lookup = (hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, "");
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => isBlockedAddress(a.address, opts.allowPrivate));
      if (bad || list.length === 0) return cb(Object.assign(new Error("upstream address is not allowed"), { code: "EBLOCKED" }), "");
      const wantAll = (options as { all?: boolean }).all;
      if (wantAll) return cb(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    });
  };
  const req = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(target, {
      method,
      headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}), connection: "close" },
      lookup: lookup as never,
      timeout: timeoutMs,
    }, (res) => {
      // Redirects are not followed: the seller's upstream must answer directly.
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          r.destroy(new Error("upstream response too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (FORWARD_RESPONSE_HEADERS.has(k) && typeof v === "string" && !/[\r\n]/.test(v)) out[k] = v;
        }
        resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    r.on("timeout", () => r.destroy(new Error("upstream timed out")));
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
