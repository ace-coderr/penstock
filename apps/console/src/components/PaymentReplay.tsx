import { useEffect, useState } from "react";
import { useMotionAllowed, useReveal } from "../motion";

/**
 * "How a payment works": the four steps of one cross-chain x402 payment as a terminal transcript.
 * Lines appear one by one the first time the panel scrolls into view; Replay runs it again.
 * Under prefers-reduced-motion every line is shown at once. The transcript is illustrative.
 */
type Who = "agent" | "penstock" | "1click";
const STEPS: { title: string; lines: { who: Who; dir: "→" | "←" | "·"; text: string; ok?: boolean }[] }[] = [
  {
    title: "Agent requests",
    lines: [{ who: "agent", dir: "→", text: "GET /p/tidewater/voyage-plan" }],
  },
  {
    title: "Gets 402",
    lines: [
      { who: "penstock", dir: "←", text: "402 Payment Required · price $0.25 · pay to tidewater-data.near" },
      { who: "penstock", dir: "·", text: "accepts: USDC on NEAR (exact) · any listed chain and token via NEAR Intents" },
    ],
  },
  {
    title: "Pays from another chain",
    lines: [
      { who: "agent", dir: "→", text: "quote: ETH on Arbitrum → 0.25 USDC on NEAR · refund to the payer on Arbitrum" },
      { who: "agent", dir: "→", text: "sends ETH to the one-time deposit address" },
      { who: "1click", dir: "·", text: "PENDING_DEPOSIT → PROCESSING → SUCCESS · USDC delivered on NEAR", ok: true },
    ],
  },
  {
    title: "200 + signed receipt",
    lines: [
      { who: "agent", dir: "→", text: "GET /p/tidewater/voyage-plan · PAYMENT-SIGNATURE" },
      { who: "penstock", dir: "←", text: "200 OK · PAYMENT-RESPONSE: receipt signed ed25519 ✓", ok: true },
    ],
  },
];

const LINES = STEPS.flatMap((s, step) => s.lines.map((l) => ({ ...l, step })));
const TICK_MS = 700;

export function PaymentReplay() {
  const [ref, seen] = useReveal<HTMLDivElement>();
  const [shown, setShown] = useState(0);
  const [run, setRun] = useState(0);
  const motion = useMotionAllowed();

  // Start once when revealed; each Replay bumps `run` and starts again from the first line.
  useEffect(() => {
    if (!seen) return;
    if (!motion) {
      setShown(LINES.length);
      return;
    }
    setShown(0);
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= LINES.length) clearInterval(t);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [seen, run, motion]);

  const current = shown === 0 ? -1 : LINES[Math.min(shown, LINES.length) - 1]!.step;
  const done = shown >= LINES.length;
  return (
    <div className="replay" ref={ref}>
      <ol className="replay-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className={i < current || (done && i <= current) ? "is-done" : i === current ? "is-on" : undefined} aria-current={i === current && !done ? "step" : undefined}>
            <span className="mono">0{i + 1}</span>
            <span>{s.title}</span>
          </li>
        ))}
      </ol>
      <div className="term">
        <div className="term-bar">
          <span className="term-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="mono term-title">one payment · illustrative, simulated</span>
          <button type="button" className="btn btn-ghost term-replay" onClick={() => setRun((r) => r + 1)} disabled={!done}>
            Replay
          </button>
        </div>
        <ol className="term-body mono" aria-live="polite">
          {LINES.slice(0, shown).map((l, i) => (
            <li key={`${run}-${i}`} className={`term-line term-${l.who}${l.ok ? " term-ok" : ""}`}>
              <span className="term-who">{l.who}</span>
              <span className="term-dir" aria-hidden="true">{l.dir}</span>
              <span className="term-text">{l.text}</span>
            </li>
          ))}
          {!done && <li className="term-cursor" aria-hidden="true" />}
        </ol>
      </div>
    </div>
  );
}
