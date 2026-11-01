import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createUpstreamServer } from "../src/index";

const server = createUpstreamServer();
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("example upstream APIs", () => {
  it("returns four alternating tide events", async () => {
    const body = (await (await fetch(`${base}/tides?harbor=singapore`)).json()) as { events: { type: string }[] };
    expect(body.events).toHaveLength(4);
    expect(body.events[0]!.type).not.toBe(body.events[1]!.type);
  });
  it("speaks minimal MCP for the summarize tool", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "summarize", arguments: { text: "Berth 4 closed. Pilot required. Strong winds after 18:00. Expect delays." } } }) });
    const body = (await r.json()) as { result: { structuredContent: { lines: string[] } } };
    expect(body.result.structuredContent.lines).toHaveLength(3);
  });
});
