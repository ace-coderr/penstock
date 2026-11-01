import { join } from "node:path";
import { loadConfig, seedStore, Store } from "@penstock/core";

const config = loadConfig();
if (config.mode === "live") {
  console.error("refusing to seed simulated data into a live-mode ledger");
  process.exit(1);
}
const store = new Store(join(config.dataDir, `penstock-${config.mode}.sqlite`));
const summary = seedStore(store, { origin: config.publicUrl, upstream: "http://127.0.0.1:4030", homeNearAccount: config.sellerNearAccount });
console.log(`seeded (simulated): ${JSON.stringify(summary)}`);
store.close();
