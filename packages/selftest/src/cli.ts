import { formatReport, runSelftest } from "./index";

const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith("--"));
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : "true") : undefined;
};

if (!url || argv.includes("--help")) {
  console.log(`usage: pnpm selftest <paywalled-url> [--holdings base:USDC,sol:SOL] [--pay] [--max-usd 0.05] [--json]

  Simulated targets (demo/dry) are paid end to end with simulated wallets.
  Live targets get a real 1Click dry quote; --pay pays a tiny amount in USDC on NEAR
  (needs PENSTOCK_NEAR_ACCOUNT and PENSTOCK_NEAR_KEY).`);
  process.exit(url ? 0 : 2);
}

const maxUsd = flag("max-usd") ? Number(flag("max-usd")) : undefined;
const result = await runSelftest({ url, holdings: flag("holdings"), pay: flag("pay") === "true", maxUsd });
console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : formatReport(result, url));
process.exit(result.pass ? 0 : 1);
