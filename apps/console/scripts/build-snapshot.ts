/**
 * Writes static-public/demo-snapshot.json for the hosted (static) demo. Runs the real seed
 * generator in memory; needs no network, keys or database file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Store, seedStore } from "@penstock/core";
import { buildSnapshot } from "./snapshot";

const origin = "http://localhost:4020"; // what a local `pnpm demo` shows; the hosted demo calls no server
const store = new Store(":memory:");
seedStore(store, { origin, upstream: "http://127.0.0.1:4030" });
const snapshot = buildSnapshot(store, { origin });
const dir = new URL("../static-public/", import.meta.url);
mkdirSync(dir, { recursive: true });
const json = JSON.stringify(snapshot);
writeFileSync(new URL("demo-snapshot.json", dir), json);
console.log(`demo snapshot: ${snapshot.payments.length} payments, ${snapshot.probes.length} probes, ${snapshot.sessions.length} sessions, ${(json.length / 1024).toFixed(0)} KB (simulated)`);
store.close();
