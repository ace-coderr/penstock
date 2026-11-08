import type { PenstockBuyer } from "./client";
import { plainEnvelope, envelopeFor } from "./envelope";

/**
 * The buyer as an MCP server (protocol 2025-06-18, tools only). Transport-independent: `handle`
 * takes one JSON-RPC message and returns the response (or null for notifications).
 *
 * Every penstock_* result carries the same envelope (state, money_moved, amount_usdc, price, route
 * fee, total debited, payment_id, operation_id, do_not_retry, next_action, paid_total_usdc).
 */

const PROTOCOL = "2025-06-18";

export const TOOLS = [
  {
    name: "penstock_search",
    description: "Find paid APIs and MCP tools sold through Penstock, by capability and maximum price per call. Cheapest first. Moves no money.",
    inputSchema: { type: "object", properties: { capability: { type: "string", description: "e.g. tides, translate, weather" }, maxPriceUsd: { type: "number" } } },
  },
  {
    name: "penstock_routes",
    description: "Rank this agent's holdings (any chain, any token) by what paying a given Penstock endpoint would cost: price, route fee and total, with time. Moves no money.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "penstock_call",
    description:
      "Call a Penstock endpoint. Handles HTTP 402 automatically: picks the cheapest holding, pays (USDC on NEAR directly or any chain via NEAR Intents) and returns the result with the receipt. " +
      "If it returns an error AFTER a payment may have been sent, do NOT call it again: read state, money_moved and next_action, and call penstock_status. A repeat of the same call never opens a second payment while the first is unresolved; it returns the first one's result. " +
      "maxUsd is the most you will let this call cost IN TOTAL: price plus route fee, so set it a little above the price (the refusal message states the total). " +
      "Pass new_purchase: true only when you really want to buy the same thing again.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST"] },
        body: { type: "string" },
        maxUsd: { type: "number", description: "Most this call may cost in total: price PLUS route fee. If it is below the total the call is refused and nothing is paid." },
        new_purchase: { type: "boolean", description: "Buy again even though an earlier identical call was paid. Ignored while an earlier payment is still unresolved." },
      },
      required: ["url"],
    },
  },
  {
    name: "penstock_status",
    description:
      "What happened to a payment, confirmed with the seller. Use it after any error from penstock_call before doing anything else. Returns state, money_moved (yes/no/unknown), the payment_id and signed receipt when the payment settled, refund state and next_action. operation_id is optional: 'last' (default) is the most recent operation. Moves no money.",
    inputSchema: { type: "object", properties: { operation_id: { type: "string", description: "An operation_id from an earlier result, or \"last\"" } } },
  },
  {
    name: "penstock_resume",
    description: "Finish a payment after sending a deposit yourself (when penstock_call asked you to). Give the operation_id from that result and the deposit's transaction hash. It never sends a second deposit.",
    inputSchema: { type: "object", properties: { operation_id: { type: "string" }, tx_hash: { type: "string" }, resumeId: { type: "string", description: "same as operation_id" }, txHash: { type: "string", description: "same as tx_hash" } } },
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

export function createMcpHandler(buyer: PenstockBuyer, info = { name: "penstock-buyer", version: "0.2.0" }) {
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
        const startedAt = Date.now();
        const name = msg.params?.name;
        try {
          switch (name) {
            case "penstock_search": {
              const results = await buyer.search(typeof a.capability === "string" ? a.capability : undefined, typeof a.maxPriceUsd === "number" ? a.maxPriceUsd : undefined);
              return ok(text({ ...plainEnvelope(buyer.journal.paidTotal(), "Nothing was bought. Call penstock_call with a url from results to buy.", "ok"), results }));
            }
            case "penstock_routes": {
              const routes = await buyer.routes(String(a.url));
              return ok(text({ ...plainEnvelope(buyer.journal.paidTotal(), "Nothing was bought. Each route lists amountInUsd (total) and feeUsd; set maxUsd on penstock_call at or above the cheapest route's total.", "ok"), routes }));
            }
            case "penstock_call": {
              const method = a.method === "POST" ? "POST" : "GET";
              const init: RequestInit = method === "POST" ? { method, headers: { "content-type": "application/json" }, body: typeof a.body === "string" ? a.body : "{}" } : { method };
              const r = await buyer.call(String(a.url), init, typeof a.maxUsd === "number" ? a.maxUsd : undefined, { newPurchase: a.new_purchase === true });
              return ok(text(r, !r.paid && r.status >= 400 && !r.depositRequired));
            }
            case "penstock_status": {
              const r = await buyer.status(typeof a.operation_id === "string" && a.operation_id ? a.operation_id : "last");
              return ok(text(r, false));
            }
            case "penstock_resume": {
              const id = String(a.operation_id ?? a.resumeId ?? "");
              const tx = String(a.tx_hash ?? a.txHash ?? "");
              if (!id || !tx) return ok(text({ ...plainEnvelope(buyer.journal.paidTotal(), "Give operation_id and tx_hash. Nothing was sent."), error: "operation_id and tx_hash are required" }, true));
              return ok(text(await buyer.resume(id, tx), false));
            }
            default:
              return fail(-32602, `unknown tool ${name}`);
          }
        } catch (e) {
          // Whatever the journal says is the truth: if this call got as far as an operation, report that, never "nothing was paid".
          const op = name === "penstock_call" || name === "penstock_resume" ? buyer.journal.all().filter((o) => o.updatedAt >= startedAt).pop() : undefined;
          const env = op
            ? envelopeFor(op, buyer.journal.paidTotal())
            : plainEnvelope(buyer.journal.paidTotal(), name === "penstock_call" ? "The call failed before any payment step, so no deposit was started. You may try again." : "The tool failed. No payment was started by this tool.");
          return ok(text({ ...env, error: (e as Error).message }, true));
        }
      }
      default:
        return fail(-32601, "method not found");
    }
  };
}
