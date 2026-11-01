import type { PenstockBuyer } from "./client";

/**
 * The buyer as an MCP server (protocol 2025-06-18, tools only). Transport-independent: `handle`
 * takes one JSON-RPC message and returns the response (or null for notifications).
 */

const PROTOCOL = "2025-06-18";

export const TOOLS = [
  {
    name: "penstock_search",
    description: "Find paid APIs and MCP tools sold through Penstock, by capability and maximum price per call. Cheapest first.",
    inputSchema: { type: "object", properties: { capability: { type: "string", description: "e.g. tides, translate, weather" }, maxPriceUsd: { type: "number" } } },
  },
  {
    name: "penstock_routes",
    description: "Rank this agent's holdings (any chain, any token) by what paying a given Penstock endpoint would cost, with fee and time.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "penstock_call",
    description: "Call a Penstock endpoint. Handles HTTP 402 automatically: picks the cheapest holding, pays (USDC on NEAR directly or any chain via NEAR Intents) and returns the result with the receipt.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "POST"] }, body: { type: "string" }, maxUsd: { type: "number", description: "Do not pay more than this for the call" } },
      required: ["url"],
    },
  },
  {
    name: "penstock_resume",
    description: "Finish a payment after sending a deposit yourself (when penstock_call returned depositRequired).",
    inputSchema: { type: "object", properties: { resumeId: { type: "string" }, txHash: { type: "string" } }, required: ["resumeId", "txHash"] },
  },
];

interface Msg {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function text(result: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown>, ...(isError ? { isError: true } : {}) };
}

export function createMcpHandler(buyer: PenstockBuyer, info = { name: "penstock-buyer", version: "0.1.0" }) {
  return async function handle(msg: Msg): Promise<unknown | null> {
    if (msg.id === undefined || msg.id === null) return null; // notification
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize":
        return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: info });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const a = msg.params?.arguments ?? {};
        try {
          switch (msg.params?.name) {
            case "penstock_search":
              return ok(text({ results: await buyer.search(typeof a.capability === "string" ? a.capability : undefined, typeof a.maxPriceUsd === "number" ? a.maxPriceUsd : undefined) }));
            case "penstock_routes":
              return ok(text({ routes: await buyer.routes(String(a.url)) }));
            case "penstock_call": {
              const method = a.method === "POST" ? "POST" : "GET";
              const init: RequestInit = method === "POST" ? { method, headers: { "content-type": "application/json" }, body: typeof a.body === "string" ? a.body : "{}" } : { method };
              const r = await buyer.call(String(a.url), init, typeof a.maxUsd === "number" ? a.maxUsd : undefined);
              return ok(text(r, !r.paid && r.status >= 400 && !r.depositRequired));
            }
            case "penstock_resume":
              return ok(text(await buyer.resume(String(a.resumeId), String(a.txHash))));
            default:
              return fail(-32602, `unknown tool ${msg.params?.name}`);
          }
        } catch (e) {
          return ok(text({ error: (e as Error).message }, true));
        }
      }
      default:
        return fail(-32601, "method not found");
    }
  };
}
