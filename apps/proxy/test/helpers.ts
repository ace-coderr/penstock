import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { loadConfig, Store, type PaymentPayload, type PaymentRequired } from "@penstock/core";
import { createUpstreamServer } from "@penstock/example-upstream-apis";
import { createProxy, type Proxy, type ProxyOptions } from "../src/index";

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

export interface Harness {
  base: string;
  proxy: Proxy;
  stop(): Promise<void>;
}

/** Starts the example upstream APIs and a demo-mode proxy on random ports. */
export async function startHarness(env: Record<string, string> = {}, opts: Partial<ProxyOptions> = {}): Promise<Harness> {
  const upstream = createUpstreamServer();
  const upstreamBase = await listen(upstream);
  // Reserve a port for the proxy first so PUBLIC_URL (and resource URLs) are right.
  const probe = createUpstreamServer();
  const tmp = await listen(probe);
  await close(probe);
  const port = new URL(tmp).port;
  const config = loadConfig({ MODE: "demo", PORT: port, PUBLIC_URL: `http://127.0.0.1:${port}`, ...env });
  const proxy = createProxy({ config, store: new Store(":memory:"), upstreamBase, ...opts });
  await new Promise<void>((r) => proxy.server.listen(Number(port), "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${port}`,
    proxy,
    async stop() {
      await close(proxy.server);
      await close(upstream);
    },
  };
}

export async function get402(url: string, init?: RequestInit): Promise<{ res: Response; required: PaymentRequired }> {
  const res = await fetch(url, init);
  const header = res.headers.get("payment-required");
  if (!header) throw new Error(`expected PAYMENT-REQUIRED, got ${res.status}`);
  return { res, required: decodePaymentRequiredHeader(header) as PaymentRequired };
}

export function paidInit(payload: PaymentPayload, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } };
}
