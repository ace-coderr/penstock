/**
 * `pnpm demo`: everything in demo mode, in one process. No keys, no funds, no network.
 *   - example upstream APIs   http://127.0.0.1:4030
 *   - Penstock proxy          http://localhost:4020
 *   - seller console          http://localhost:4021
 *   - a simulated buyer agent that pays from random chains every few seconds (--no-agent to stop it)
 * Flags: --no-open (do not open a browser), --no-agent, --keep (keep the previous demo ledger).
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "@penstock/core";

const root = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const PROXY_PORT = Number(process.env.PORT ?? 4020);
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 4021);
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 4030);

function portFree(port: number, host?: string): Promise<boolean> {
  return new Promise((ok) => {
    const s = netServer().once("error", () => ok(false)).once("listening", () => s.close(() => ok(true)));
    s.listen(port, host);
  });
}

async function main() {
  for (const [port, name, env] of [[PROXY_PORT, "proxy", "PORT"], [CONSOLE_PORT, "console", "CONSOLE_PORT"], [UPSTREAM_PORT, "example upstream", "UPSTREAM_PORT"]] as const) {
    if (!(await portFree(port))) {
      console.error(`\nPort ${port} (${name}) is already in use. Stop whatever uses it, or run with ${env}=<free port>.\n`);
      process.exit(1);
    }
  }

  const dataDir = join(root, "data", "demo");
  if (!args.has("--keep")) rmSync(dataDir, { recursive: true, force: true });
  Object.assign(process.env, {
    MODE: "demo",
    PORT: String(PROXY_PORT),
    PUBLIC_URL: `http://localhost:${PROXY_PORT}`,
    CONSOLE_URL: `http://localhost:${CONSOLE_PORT}`,
    DATA_DIR: dataDir,
    PENSTOCK_LOG: process.env.PENSTOCK_LOG ?? "warn",
    PENSTOCK_PROXY_URL: `http://localhost:${PROXY_PORT}`,
    CONSOLE_PORT: String(CONSOLE_PORT),
  });
  const config = loadConfig();

  const { createUpstreamServer } = await import("@penstock/example-upstream-apis");
  const upstream = createUpstreamServer();
  await new Promise<void>((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

  const { createProxy } = await import("@penstock/proxy");
  const proxy = createProxy({ config, upstreamBase: `http://127.0.0.1:${UPSTREAM_PORT}` });
  await new Promise<void>((r) => proxy.server.listen(PROXY_PORT, r));

  const consoleRoot = join(root, "apps", "console");
  const req = createRequire(join(consoleRoot, "package.json"));
  const vite = (await import(pathToFileURL(req.resolve("vite")).href)) as { createServer(o: object): Promise<{ listen(): Promise<unknown>; close(): Promise<void> }> };
  const ui = await vite.createServer({ root: consoleRoot, configFile: join(consoleRoot, "vite.config.ts"), logLevel: "warn", server: { port: CONSOLE_PORT, strictPort: true } });
  await ui.listen();

  const consoleUrl = `http://localhost:${CONSOLE_PORT}/`;
  console.log(`
  PENSTOCK  demo mode: every quote, deposit and settlement is SIMULATED. No keys, no funds, no network.

  console     ${consoleUrl}
  proxy       http://localhost:${PROXY_PORT}/healthz
  discovery   http://localhost:${PROXY_PORT}/.well-known/penstock.json
  paid API    http://localhost:${PROXY_PORT}/p/tidewater/tides?harbor=rotterdam   (returns 402 until paid)

  try:        pnpm selftest http://localhost:${PROXY_PORT}/p/tidewater/tides
  stop:       Ctrl+C
`);

  let agentTimer: NodeJS.Timeout | null = null;
  if (!args.has("--no-agent")) {
    const { PenstockBuyer, simulatedNearWallet, simulatedOriginWallet, parseHoldings } = await import("@penstock/buyer-mcp");
    const pool = ["base:USDC", "sol:SOL", "arb:USDC", "eth:ETH", "op:USDC", "btc:BTC", "near:USDC", "pol:USDC", "avax:AVAX", "near:wNEAR"];
    const targets = ["tides?harbor=rotterdam", "geocode?q=singapore", "tides?harbor=lagos", "harbor-brief?harbor=halifax"];
    const base = `http://localhost:${PROXY_PORT}`;
    let n = 0;
    const tick = async () => {
      const holding = pool[n % pool.length]!;
      const target = targets[n % targets.length]!;
      n++;
      const hs = parseHoldings(holding);
      const buyer = new PenstockBuyer({
        directories: [`${base}/.well-known/penstock.json`], holdings: hs, near: simulatedNearWallet(`sim-agent-${n % 7}.near`),
        origins: hs.filter((h) => h.chain !== "near").map((h) => simulatedOriginWallet(h.chain, base)),
      });
      try {
        const r = await buyer.call(`${base}/p/tidewater/${target}`);
        console.log(`  agent  ${r.paid ? "paid" : "did not pay"}  ${target.split("?")[0]!.padEnd(13)} from ${holding.padEnd(10)} ${r.paid ? `via ${r.method}` : (r.note ?? "")}  [simulated]`);
      } catch (e) {
        console.log(`  agent  error ${(e as Error).message}`);
      }
    };
    agentTimer = setInterval(() => void tick(), 7000);
    setTimeout(() => void tick(), 1500);
  }

  if (!args.has("--no-open")) {
    const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", consoleUrl]] : process.platform === "darwin" ? ["open", [consoleUrl]] : ["xdg-open", [consoleUrl]];
    try {
      spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
    } catch {
      // No browser available: the URL is printed above.
    }
  }

  const stop = async () => {
    if (agentTimer) clearInterval(agentTimer);
    await ui.close();
    proxy.server.close();
    upstream.close();
    proxy.store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
