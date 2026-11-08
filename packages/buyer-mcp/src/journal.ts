import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * The buyer's operation journal. Every payment the buyer starts is one operation, written down
 * BEFORE anything is sent (write-ahead), so a crash, a lost response or an agent that simply calls
 * again can never be mistaken for "nothing happened".
 *
 * Storage: an append-only JSON-lines file. Each line holds a full snapshot of one operation (the
 * newest snapshot wins) and is chained to the line before it with an HMAC, so edits, deletions and
 * reordering are detected. The HMAC key lives next to the journal: this catches accidents and
 * naive edits, not someone who can read the key file. A torn last line (crash mid-write) is dropped:
 * it was never durable, so nothing was sent after it. Writes are fsynced. A lock file makes the
 * check-then-claim step safe across processes; inside one process the code is single-threaded.
 */

export type OperationState =
  | "quoted" // intent recorded and quote obtained; no deposit has been started
  | "deposit_sent_unconfirmed" // a deposit was started (write-ahead) or sent; the seller has not confirmed it
  | "confirming" // the deposit's transaction hash is known; waiting for the seller to confirm delivery
  | "delivered"
  | "upstream_failed_after_settlement"
  | "refunded"
  | "expired" // the quote ran out before any deposit was started
  | "failed";

export const TERMINAL_STATES: ReadonlySet<OperationState> = new Set(["delivered", "upstream_failed_after_settlement", "refunded", "expired", "failed"]);

export type RefundState = "none" | "in_progress" | "owed" | "refunded";

export interface OperationRequest {
  method: "GET" | "POST";
  /** Only content-type and accept are kept; nothing secret travels in a journal. */
  headers: Record<string, string>;
  body: string | null;
}

export interface Operation {
  id: string;
  key: string;
  buyer: string;
  method: "exact-near" | "near-intents";
  /** What was bought: the paid URL (for a session: the session-open URL). */
  url: string;
  paramsHash: string;
  request: OperationRequest;
  state: OperationState;
  createdAt: number;
  updatedAt: number;
  /** USDC base units the seller receives for this operation (the price). */
  amountUsdc: string;
  /** Route fee in USDC base units (what the bridge and swap cost on top of the price). */
  feeUsdc: string;
  /** Total taken from the buyer, in USDC base units of value (price + fee). */
  debitedUsdc: string;
  /** What actually leaves the wallet, in the origin asset. */
  debited: { amount: string; symbol: string } | null;
  /** The seller's payment id once the payment is booked (from the signed receipt). */
  paymentId: string | null;
  originChain: string | null;
  originSymbol: string | null;
  /** Quote terms (near-intents). */
  quote: { resourceUrl: string; unquoted: unknown; payTo: string; amount: string; depositMemo?: string; refundDeadline: string; operationToken: string; refundTo: string } | null;
  /** exact-near: the signed payload header that was sent, so it can be presented again unchanged. */
  exactPayload: string | null;
  txHash: string | null;
  /** The agent must send the deposit itself (live mode) and call penstock_resume. */
  manualDeposit: boolean;
  receipt: unknown | null;
  settlement: unknown | null;
  /** Delivered body or the last response body, kept (truncated) so a lost result can be handed back. */
  resultBody: unknown | null;
  resultStatus: number | null;
  /** The terminal result has been handed to the agent. */
  acknowledged: boolean;
  /** penstock_status has been looked at since the operation reached a money-moved terminal state. */
  statusViewed: boolean;
  refundState: RefundState;
  refundAmountUsdc: string | null;
  lastError: string | null;
  note: string | null;
}

export class JournalIntegrityError extends Error {}

interface Line {
  n: number;
  prev: string;
  rec: Operation;
  mac: string;
}

const ZERO = "0".repeat(64);

export class Journal {
  private readonly ops = new Map<string, Operation>();
  private order: string[] = [];
  private lastMac = ZERO;
  private n = 0;
  private readonly file: string | null;
  private readonly lockFile: string | null;
  private readonly macKey: Buffer;
  /** Set when a stored line failed its integrity check; new purchases are refused while set. */
  tampered: { line: number } | null = null;

  constructor(readonly opts: { dir?: string; now?: () => number; compactAt?: number } = {}) {
    if (opts.dir) {
      mkdirSync(opts.dir, { recursive: true });
      this.file = join(opts.dir, "journal.jsonl");
      this.lockFile = join(opts.dir, "journal.lock");
      const keyFile = join(opts.dir, "journal.key");
      if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
      this.macKey = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
      this.load();
    } else {
      this.file = null;
      this.lockFile = null;
      this.macKey = randomBytes(32);
    }
  }

  get persistent(): boolean {
    return this.file !== null;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private mac(prev: string, rec: Operation): string {
    return createHmac("sha256", this.macKey).update(prev).update("\n").update(JSON.stringify(rec)).digest("hex");
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    const text = readFileSync(this.file, "utf8");
    const lines = text.split("\n");
    let lastIdx = lines.length - 1;
    while (lastIdx >= 0 && !lines[lastIdx]) lastIdx--;
    const tornAllowed = !text.endsWith("\n");
    let prev = ZERO;
    let good = "";
    for (let i = 0; i <= lastIdx; i++) {
      const raw = lines[i]!;
      if (!raw) continue;
      let parsed: Line | null;
      try {
        parsed = JSON.parse(raw) as Line;
      } catch {
        parsed = null;
      }
      if (!parsed) {
        // Only the final line may be torn by a crash. It was never durable, so nothing was sent after it:
        // drop it (and cut it from the file so the next append starts on a clean line).
        if (i === lastIdx && tornAllowed) {
          writeFileSync(this.file, good, { mode: 0o600 });
          break;
        }
        this.tampered = { line: i + 1 };
        return;
      }
      if (parsed.prev !== prev || parsed.mac !== this.mac(prev, parsed.rec) || parsed.n !== this.n + 1) {
        this.tampered = { line: i + 1 };
        return;
      }
      prev = parsed.mac;
      this.n = parsed.n;
      good += raw + "\n";
      this.apply(parsed.rec);
    }
    this.lastMac = prev;
    if (this.n > (this.opts.compactAt ?? 2000)) this.compact();
  }

  /** Rewrites the file with only the newest snapshot of each operation, as a fresh chain. Runs at load only. */
  private compact(): void {
    if (!this.file) return;
    let prev = ZERO;
    let n = 0;
    let out = "";
    for (const id of this.order) {
      const rec = this.ops.get(id)!;
      const line: Line = { n: ++n, prev, rec, mac: "" };
      line.mac = this.mac(prev, rec);
      prev = line.mac;
      out += JSON.stringify(line) + "\n";
    }
    writeFileSync(this.file, out, { mode: 0o600 });
    this.n = n;
    this.lastMac = prev;
  }

  private apply(rec: Operation): void {
    if (!this.ops.has(rec.id)) this.order.push(rec.id);
    this.ops.set(rec.id, rec);
  }

  private persist(rec: Operation): void {
    if (this.tampered) throw new JournalIntegrityError(`the journal failed its integrity check at line ${this.tampered.line}`);
    const line: Line = { n: this.n + 1, prev: this.lastMac, rec, mac: "" };
    line.mac = this.mac(line.prev, rec);
    if (this.file) {
      const fd = openSync(this.file, "a", 0o600);
      try {
        writeSync(fd, JSON.stringify(line) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.n = line.n;
    this.lastMac = line.mac;
    this.apply(rec);
  }

  /** Runs `fn` while holding the cross-process lock (the claim step: read the key's state, then insert). */
  withLock<T>(fn: () => T): T {
    if (!this.lockFile) return fn();
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, "wx");
        writeSync(fd, `${process.pid}`);
        closeSync(fd);
        break;
      } catch {
        // A lock older than 30 s belongs to a crashed process.
        try {
          if (Date.now() - statSync(this.lockFile).mtimeMs > 30_000) unlinkSync(this.lockFile);
        } catch {
          /* it was released meanwhile */
        }
        if (Date.now() > deadline) throw new Error("the journal is locked by another process");
        const until = Date.now() + 20;
        while (Date.now() < until) {
          /* brief spin: the critical section is a few milliseconds */
        }
      }
    }
    try {
      this.reloadIfChanged();
      return fn();
    } finally {
      try {
        unlinkSync(this.lockFile);
      } catch {
        /* already gone */
      }
    }
  }

  /** Picks up lines another process appended since this one last looked. */
  private reloadIfChanged(): void {
    if (!this.file || !existsSync(this.file)) return;
    const size = statSync(this.file).size;
    if (size === 0) return;
    this.ops.clear();
    this.order = [];
    this.n = 0;
    this.lastMac = ZERO;
    this.tampered = null;
    this.load();
  }

  newId(): string {
    return `op_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  get(id: string): Operation | undefined {
    return this.ops.get(id);
  }

  /** The newest operation for a key. */
  latest(key: string): Operation | undefined {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const op = this.ops.get(this.order[i]!)!;
      if (op.key === key) return op;
    }
    return undefined;
  }

  /** The operation most recently created or changed. */
  last(): Operation | undefined {
    let best: Operation | undefined;
    for (const op of this.ops.values()) if (!best || op.updatedAt >= best.updatedAt) best = op;
    return best;
  }

  all(): Operation[] {
    return this.order.map((id) => this.ops.get(id)!);
  }

  insert(op: Omit<Operation, "id" | "createdAt" | "updatedAt">): Operation {
    const t = this.now();
    const rec: Operation = { ...op, id: this.newId(), createdAt: t, updatedAt: t };
    this.persist(rec);
    return rec;
  }

  update(id: string, patch: Partial<Operation>): Operation {
    const cur = this.ops.get(id);
    if (!cur) throw new Error(`unknown operation ${id}`);
    const next: Operation = { ...cur, ...patch, id: cur.id, key: cur.key, createdAt: cur.createdAt, updatedAt: this.now() };
    this.persist(next);
    return next;
  }

  /** USDC base units of value sent and not returned, fees included: every operation where money moved or may have. */
  paidTotal(): bigint {
    let sum = 0n;
    for (const op of this.ops.values()) if (movedMoney(op) !== "no") sum += BigInt(op.debitedUsdc || op.amountUsdc);
    return sum;
  }
}

export type MoneyMoved = "yes" | "no" | "unknown";

/** Whether this operation's money left the buyer and has not come back. */
export function movedMoney(op: Operation): MoneyMoved {
  switch (op.state) {
    case "delivered":
    case "upstream_failed_after_settlement":
    case "confirming":
      return "yes";
    case "deposit_sent_unconfirmed":
      return op.txHash || op.exactPayload ? "yes" : "unknown";
    case "refunded":
    case "expired":
      return "no";
    case "failed":
      // A failure after a deposit exists is not proof that nothing moved.
      return op.txHash ? (op.refundState === "refunded" ? "no" : "yes") : op.exactPayload ? "unknown" : "no";
    case "quoted":
      return "no";
  }
}

export function hashParams(method: string, body: string | null): string {
  return createHash("sha256").update(method).update("\n").update(body ?? "").digest("hex").slice(0, 32);
}

export function operationKey(buyer: string, method: string, url: string, paramsHash: string): string {
  return createHash("sha256").update([buyer, method, url, paramsHash].join("\n")).digest("hex").slice(0, 32);
}
