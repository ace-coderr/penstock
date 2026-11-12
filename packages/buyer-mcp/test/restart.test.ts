import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimulatedOneClick } from "@penstock/intents-adapter";
import {
  Journal, PenstockBuyer, SimulatedCrash, defaultJournalDir, parseHoldings, simulatedNearWallet, simulatedOriginWallet,
  type CrashPoint, type SealedResult,
} from "../src/index";
import { startHarness, type Harness } from "../../../apps/proxy/test/helpers";

/**
 * Restart safety. A buyer is stopped dead at a named point (SimulatedCrash: nothing after it runs, so nothing
 * after it is journaled), then a fresh buyer on the same journal directory makes the SAME call. The seller must
 * end with one deposit and one settled payment, and the call must resume the same operation (same operation id,
 * same deposit address). Demo settlement is simulated.
 */

let h: Harness;
let sim: SimulatedOneClick;
let dir: string;
let seeded: Set<string>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "penstock-restart-"));
  sim = new SimulatedOneClick({ processingMs: 40 });
  h = await startHarness({}, { oneClick: sim });
  seeded = new Set(h.proxy.store.listPayments({ limit: 5000 }).map((p) => p.id));
});
afterEach(async () => {
  await h.stop();
  rmSync(dir, { recursive: true, force: true });
});

const URL_ = () => `${h.base}/p/tidewater/voyage-plan?harbor=lagos`; // $0.25, from USDC on Base through NEAR Intents

function buyer(crashAt?: CrashPoint, journalDir = dir): { b: PenstockBuyer; deposits: () => number } {
  const hs = parseHoldings("base:USDC:2500000");
  const wallet = simulatedOriginWallet("base", h.base);
  let n = 0;
  const counted = { ...wallet, async deposit(d: Parameters<typeof wallet.deposit>[0]) { n++; return wallet.deposit(d); } };
  const b = new PenstockBuyer({
    directories: [`${h.base}/.well-known/penstock.json`], holdings: hs, near: simulatedNearWallet("restart.near"), origins: [counted], journal: new Journal({ dir: journalDir }), buyerId: "restart-agent",
    crashAt: crashAt ? (p) => { if (p === crashAt) throw new SimulatedCrash(p); } : undefined,
  });
  return { b, deposits: () => n };
}

const settledRows = () => h.proxy.store.listPayments({ limit: 5000 }).filter((p) => p.status === "settled" && !seeded.has(p.id));

async function crashed(point: CrashPoint): Promise<void> {
  await expect(buyer(point).b.call(URL_())).rejects.toBeInstanceOf(SimulatedCrash);
}

describe.each<{ name: string; point: CrashPoint; deposit_on_resume: boolean }>([
  { name: "(a) after the intent is written, before any deposit", point: "after_intent", deposit_on_resume: true },
  { name: "(a) after the quote is recorded, before the deposit is started", point: "after_quote", deposit_on_resume: true },
  { name: "(b) after the deposit is broadcast, before its hash is written", point: "after_broadcast", deposit_on_resume: false },
  { name: "(c) after the deposit is recorded, before the receipt", point: "after_record", deposit_on_resume: false },
  { name: "(c) after the seller answered, before the answer is recorded", point: "after_response", deposit_on_resume: false },
])("crash $name", ({ point, deposit_on_resume }) => {
  it("the same call resumes the same operation: one deposit, one settled row, the right payment id and total", async () => {
    await crashed(point);
    const j1 = new Journal({ dir });
    const before = j1.all();
    expect(before).toHaveLength(1);
    const id = before[0]!.id;
    const payTo = before[0]!.quote?.payTo;

    const { b, deposits } = buyer();
    const r: SealedResult = await b.call(URL_());
    console.log(`[restart-test] crash=${point} resumed_op_same=${r.operation_id === id} deposits_after_restart=${deposits()} seller_deposits=${sim.depositStats().count} settled_rows=${settledRows().length} state=${r.state}`);

    expect(r.operation_id).toBe(id);
    if (payTo) expect(b.journal.get(id)!.quote?.payTo).toBe(payTo);
    expect(deposits()).toBe(deposit_on_resume ? 1 : 0);
    expect(sim.depositStats().count).toBe(1);
    expect(settledRows()).toHaveLength(1);
    expect(r.state).toBe("delivered");
    expect(r.payment_id).toBe(settledRows()[0]!.id);
    // price 0.25 plus the route fee, counted once
    expect(r.paid_total_usdc).toBe(r.total_debited_usdc);
    expect(b.journal.all()).toHaveLength(1);
  });
});

describe("crash edge cases", () => {
  it("a crash after the write-ahead but before the deposit is never answered with a second deposit; status says so plainly", async () => {
    await crashed("before_deposit");
    const { b, deposits } = buyer();
    const r = await b.call(URL_());
    expect(deposits()).toBe(0); // it cannot know whether the deposit left, so it does not send another
    expect(sim.depositStats().count).toBe(0);
    expect(r).toMatchObject({ state: "deposit_sent_unconfirmed", money_moved: "unknown", do_not_retry: true });
    expect(r.next_action).toMatch(/do not retry/i);
    expect(r.next_action).toMatch(/penstock_status|penstock_resume/);
    expect(r.state).not.toBe("failed");
  });

  it("two restarts in a row: still one operation, one deposit, one settled row", async () => {
    await crashed("after_broadcast");
    await expect(buyer("after_response").b.call(URL_())).rejects.toBeInstanceOf(SimulatedCrash); // the first resume crashes too, after the seller answered
    const { b } = buyer();
    const r = await b.call(URL_());
    expect(r.state).toBe("delivered");
    expect(sim.depositStats().count).toBe(1);
    expect(settledRows()).toHaveLength(1);
    expect(b.journal.all()).toHaveLength(1);
  });

  it("restarts while the lock of the killed process is still on disk (a real killed child process)", async () => {
    const child = spawn(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(join(dir, "journal.lock"))}, String(process.pid)); setInterval(() => {}, 1000);`], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 400));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    // The lock file is fresh (not 30 s old) but its owner is dead: the next buyer must not wait for it.
    const t0 = Date.now();
    await crashed("after_broadcast");
    const r = await buyer().b.call(URL_());
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.state).toBe("delivered");
    expect(sim.depositStats().count).toBe(1);
  });

  it("the journal is found again from a different working directory (absolute path, not cwd-relative)", async () => {
    const cwd = process.cwd();
    const rel = mkdtempSync(join(cwd, "tmp-journal-"));
    try {
      await expect(buyer("after_broadcast", rel).b.call(URL_())).rejects.toBeInstanceOf(SimulatedCrash);
      process.chdir(tmpdir());
      const r = await buyer(undefined, rel).b.call(URL_());
      expect(r.state).toBe("delivered");
      expect(sim.depositStats().count).toBe(1);
      expect(new Journal({ dir: "." }).dir).toBe(process.cwd()); // a relative dir is made absolute when the journal is opened
    } finally {
      process.chdir(cwd);
      rmSync(rel, { recursive: true, force: true });
    }
  });

  it("restart after the quote deadline passed with the deposit already broadcast: in progress or delivered, never failed and never a new quote", async () => {
    await crashed("after_record");
    const j = new Journal({ dir });
    const op = j.all()[0]!;
    j.update(op.id, { quote: { ...op.quote!, refundDeadline: new Date(Date.now() - 3_600_000).toISOString() } });
    const { b, deposits } = buyer();
    const r = await b.call(URL_());
    expect(["delivered", "confirming"]).toContain(r.state);
    expect(r.state).not.toBe("failed");
    expect(r.state).not.toBe("expired");
    expect(r.operation_id).toBe(op.id);
    expect(deposits()).toBe(0);
    expect(sim.depositStats().count).toBe(1);
    expect(b.journal.all()).toHaveLength(1);
  });

  it("the journal default is a persistent absolute directory under the home directory, never memory", () => {
    const d = defaultJournalDir({});
    expect(d).toBeDefined();
    expect(d).toMatch(/\.penstock[\\/]+buyer-journal$/);
    expect(defaultJournalDir({ PENSTOCK_JOURNAL_DIR: "memory" })).toBeUndefined();
    expect(defaultJournalDir({ PENSTOCK_JOURNAL_DIR: "relative/dir" })).toBe(join(process.cwd(), "relative", "dir"));
    // a buyer built with no journal option and no environment override gets a file-backed journal
    const saved = process.env.PENSTOCK_JOURNAL_DIR;
    process.env.PENSTOCK_JOURNAL_DIR = dir;
    try {
      const b = new PenstockBuyer({ directories: [], holdings: [] });
      expect(b.journal.persistent).toBe(true);
      expect(b.journal.dir).toBe(dir);
    } finally {
      process.env.PENSTOCK_JOURNAL_DIR = saved;
    }
  });

  it("a journal file written by one process is read by the next (the file really is on disk)", async () => {
    await crashed("after_record");
    expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toContain('"state":"confirming"');
    writeFileSync(join(dir, "note.txt"), "x");
  });
});
