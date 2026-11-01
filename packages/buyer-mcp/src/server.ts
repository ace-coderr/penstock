import { createInterface } from "node:readline";
import { buyerFromEnv } from "./env";
import { createMcpHandler } from "./mcp";

/**
 * stdio entry point: `pnpm --filter @penstock/buyer-mcp start`. Newline-delimited JSON-RPC on
 * stdin/stdout; diagnostics go to stderr so they never corrupt the protocol stream.
 */
const { buyer, summary } = buyerFromEnv(process.env);
process.stderr.write(`penstock-buyer: ${summary}\n`);
const handle = createMcpHandler(buyer);

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
    return;
  }
  const res = await handle(msg);
  if (res) process.stdout.write(JSON.stringify(res) + "\n");
});
