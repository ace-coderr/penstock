import { describe, expect, it } from "vitest";
import { ChainUnreachable, NEAR_RPCS, isNearAccountId, readAccount } from "../src/chain";

type Answer = (body: { params: { request_type: string; method_name?: string } }) => unknown;

/** A fake RPC: `down` origins throw like a network error; the rest answer with `answer`. */
function rpc(answer: Answer, down: string[] = []) {
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push(url);
    if (down.includes(url)) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer(JSON.parse(String(init.body)))));
  }) as unknown as typeof fetch;
  return { f, calls };
}
const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
const registered: Answer = (b) =>
  b.params.request_type === "view_account" ? { result: { amount: "0" } }
  : b.params.method_name === "ft_balance_of" ? { result: { result: bytes("10000") } }
  : { result: { result: bytes({ total: "1250000000000000000000", available: "0" }) } };

describe("browser chain reads", () => {
  it("reads existence, USDC balance and storage from the primary RPC", async () => {
    const { f, calls } = rpc(registered);
    const s = await readAccount("acedevv.near", f);
    expect(s).toMatchObject({ exists: true, usdcBalance: "10000", storageRegistered: true, rpc: NEAR_RPCS[0] });
    expect(new Set(calls)).toEqual(new Set([NEAR_RPCS[0]]));
  });

  it("falls back to the second RPC when the first is down", async () => {
    const { f } = rpc(registered, [NEAR_RPCS[0]]);
    expect((await readAccount("acedevv.near", f)).rpc).toBe(NEAR_RPCS[1]);
  });

  it("reports a missing account as an answer, and an outage as ChainUnreachable", async () => {
    const missing = rpc(() => ({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } }));
    expect(await readAccount("nobody-here-123.near", missing.f)).toMatchObject({ exists: false, storageRegistered: false });
    const down = rpc(registered, [...NEAR_RPCS]);
    await expect(readAccount("acedevv.near", down.f)).rejects.toBeInstanceOf(ChainUnreachable);
  });

  it("an unregistered account reads storageRegistered false", async () => {
    const unreg = rpc((b) => (b.params.method_name === "storage_balance_of" ? { result: { result: bytes(null) } } : registered(b)));
    expect((await readAccount("fresh.near", unreg.f)).storageRegistered).toBe(false);
  });

  it("validates NEAR account ids before any request", () => {
    for (const ok of ["acedevv.near", "a1.b-c_d.near", "0".repeat(64)]) expect(isNearAccountId(ok), ok).toBe(true);
    for (const bad of ["", "A.near", "x", "a..near", "-a.near", "a".repeat(65), "has space.near"]) expect(isNearAccountId(bad), bad).toBe(false);
  });
});
