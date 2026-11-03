import { useEffect, useState, type ReactNode } from "react";
import { Wordmark } from "./components/Wordmark";
import { HostedBanner } from "./components/bits";
import { STATIC_DEMO } from "./api";
import { CardArt } from "./components/Iso";
import { HeroStage } from "./components/HeroStage";
import { PaymentReplay } from "./components/PaymentReplay";
import { moneyUsd, units } from "./format";
import { useCountUp, useReveal } from "./motion";
import { useProof } from "./proof";
import { RealBadge } from "./components/OnChain";
import { RealTransactions } from "./components/RealTransactions";
import { ReceiptVerifier } from "./components/ReceiptVerifier";

const REPO = "https://github.com/ace-coderr/penstock";

interface Stats {
  simulated: boolean;
  days: number;
  seller: string;
  payments: number;
  chains: number;
  receivedUsdc: string;
}

function useStats(): { stats: Stats | null; state: "loading" | "ready" | "unavailable" } {
  const [s, set] = useState<{ stats: Stats | null; state: "loading" | "ready" | "unavailable" }>({ stats: null, state: "loading" });
  useEffect(() => {
    let live = true;
    const load: Promise<Stats> = STATIC_DEMO
      ? import("./static/sim").then((m) => m.staticApi<Stats>("/public/stats"))
      : fetch("/api/public/stats").then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
    load
      .then((stats: Stats) => live && set({ stats, state: "ready" }))
      .catch(() => live && set({ stats: null, state: "unavailable" }));
    return () => {
      live = false;
    };
  }, []);
  return s;
}

const INSTRUMENTS: { id: "protect" | "chains" | "sessions" | "books"; title: string; body: string; href: string; cta: string }[] = [
  { id: "protect", title: "Protect any endpoint", body: "Put an x402 paywall in front of any HTTP API or MCP tool. A request reaches your upstream only after it is paid, and only that upstream.", href: "/app#/endpoints", cta: "Endpoints" },
  { id: "chains", title: "Accept any chain and token", body: "Agents pay from Base, Solana, Ethereum, Arbitrum, Bitcoin and more. NEAR Intents routes the swap; you receive USDC in one NEAR account.", href: "/app#/payments", cta: "Payments" },
  { id: "sessions", title: "Sessions for micro-calls", body: "Bridges have minimums, so a $0.004 call can't cross chains alone. One payment opens a capped session; calls are metered; the rest is refunded.", href: "/app#/sessions", cta: "Sessions" },
  { id: "books", title: "Books that close", body: "Every payment carries a signed receipt. Refunds, route fees and resale margins land in one CSV an accountant can read without you.", href: "/app#/payments", cta: "Export CSV" },
];

const WORKS: { name: string; cls: string; role: string; code: string }[] = [
  { name: "NEAR Intents", cls: "wm-intents", role: "Cross-chain settlement through the 1Click API", code: "1Click API v0" },
  { name: "x402", cls: "wm-x402", role: "HTTP 402 payments for any API", code: "x402 v2" },
  { name: "MCP", cls: "wm-mcp", role: "Paid tools that agents can call", code: "_meta transport" },
];

const CHECKS: { title: string; body: string; code: string }[] = [
  { title: "Fresh quote", body: "Each cross-chain payment gets its own single-use 1Click deposit address and refund deadline. The operation token that redeems it expires.", code: "operationToken · expiry" },
  { title: "Payout account exists", body: "Before any quote, the seller's NEAR account is looked up. 1Click rejects quotes to accounts that do not exist, so Penstock says so first.", code: "view_account" },
  { title: "Price matches the endpoint", body: "Terms always come from the seller's own offer. A payment that edits the amount, payee or asset is refused.", code: "server terms only" },
  { title: "Refund path set", body: "Every cross-chain quote carries the payer's refund address on the chain they paid from. Failed or short deposits go back there.", code: "refundTo · ORIGIN_CHAIN" },
  { title: "Replay blocked", body: "A payment is claimed and executed exactly once, enforced by the ledger. Sending it again does not run the call again.", code: "claim · execute once" },
];

function Section({ id, eyebrow, title, intro, children }: { id?: string; eyebrow: string; title: ReactNode; intro?: ReactNode; children: ReactNode }) {
  const [ref, seen] = useReveal<HTMLElement>();
  return (
    <section ref={ref} className={`l-sec reveal${seen ? " is-in" : ""}`} id={id} aria-labelledby={id ? `${id}-h` : undefined}>
      <div className="l-sec-head">
        <span className="eyebrow"><i aria-hidden="true" />{eyebrow}</span>
        <h2 id={id ? `${id}-h` : undefined}>{title}</h2>
        {intro && <p>{intro}</p>}
      </div>
      {children}
    </section>
  );
}

function CountUp({ value, format, start }: { value: number; format: (n: number) => string; start: boolean }) {
  const n = useCountUp(value, { fromZero: true, start });
  return <>{format(n)}</>;
}

function Proof() {
  const { stats, state } = useStats();
  const [ref, seen] = useReveal<HTMLDivElement>();
  if (state === "loading") {
    return (
      <div className="proof" aria-busy="true" ref={ref}>
        {[0, 1, 2].map((i) => <div className="proof-item" key={i}><div className="skeleton" style={{ height: 48, width: "60%" }} /><div className="skeleton" style={{ width: "80%" }} /></div>)}
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="state">
        <span className="state-title">No demo numbers here</span>
        <p>These figures come from the local demo ledger. Run <code>pnpm demo</code> and reload; a live deployment does not publish them.</p>
      </div>
    );
  }
  const usd = Number(units(stats.receivedUsdc, 6, 2));
  const items = [
    { v: stats.payments, f: (n: number) => Math.round(n).toLocaleString("en-US"), l: `payments in ${stats.days} days` },
    { v: stats.chains, f: (n: number) => String(Math.round(n)), l: "chains paid from, one account receiving" },
    { v: usd, f: (n: number) => moneyUsd(n), l: "USDC received on NEAR" },
  ];
  return (
    <div className="proof" ref={ref}>
      {items.map((x, i) => (
        <div className={`proof-item reveal${seen ? " is-in" : ""}`} key={x.l} style={{ "--i": i } as React.CSSProperties}>
          <div className="proof-n" aria-label={x.f(x.v)}><CountUp value={x.v} format={x.f} start={seen} /></div>
          <div className="proof-l">{x.l}</div>
          <span className="sim-inline">simulated demo data</span>
        </div>
      ))}
      <RealStat seen={seen} />
    </div>
  );
}

/** One real number, counted from the real transactions in proof.json. */
function RealStat({ seen }: { seen: boolean }) {
  const { proof } = useProof();
  if (!proof) return null;
  const payments = proof.entries.filter((e) => e.kind === "payment").length;
  const refunds = proof.entries.filter((e) => e.kind === "refund").length;
  return (
    <a href="#real" className={`proof-item proof-real reveal${seen ? " is-in" : ""}`} style={{ "--i": 3 } as React.CSSProperties}>
      <div className="proof-n">{payments} + {refunds}</div>
      <div className="proof-l">real mainnet payment{payments === 1 ? "" : "s"} and refund{refunds === 1 ? "" : "s"}, with explorer links</div>
      <RealBadge />
    </a>
  );
}

function RealSection() {
  const { proof, error } = useProof();
  return (
    <Section id="real" eyebrow="Real transactions" title={<>Not a mockup: <em>one real payment, one real refund</em></>} intro="Everything above the fold is simulated demo data. These two are not: they happened on Solana and NEAR mainnet, every step links to a public explorer, and the payment's signed receipt is verified here in your browser.">
      {error ? <p className="faint">The proof record did not load. The same transactions are in <a href={`${REPO}/blob/main/docs/PROOF.md`}>docs/PROOF.md</a>.</p> : !proof ? <div className="skeleton" style={{ height: 160 }} /> : (
        <div className="l-real">
          <RealTransactions proof={proof} />
          <ReceiptVerifier receipt={proof.entries.find((e) => e.receipt)!.receipt!} />
          <p className="l-real-links">
            <a className="btn btn-primary" href="/app#/?view=real">Open the Real view in the console</a>
            <a className="btn btn-ghost" href={`${REPO}/blob/main/docs/PROOF.md`}>Read PROOF.md</a>
          </p>
        </div>
      )}
    </Section>
  );
}

export function Landing() {
  useEffect(() => {
    document.title = "Penstock: get paid by AI agents from any chain";
  }, []);
  return (
    <div className="landing">
      <a className="skip" href="#main">Skip to content</a>
      <header className="l-top">
        <HostedBanner />
        <div className="frame l-top-row">
          <a href="/" className="mark" aria-label="Penstock home"><Wordmark size={24} /></a>
          <nav className="l-links" aria-label="Site">
            <a href="#how">How it works</a>
            <a href="#real">Real transactions</a>
            <a href={`${REPO}#readme`}>Docs</a>
            <a href="/app">Demo</a>
          </nav>
          <a className="btn btn-primary l-top-cta" href="/app">Open the demo</a>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <div className="frame">
          <section className="l-hero" aria-labelledby="hero-h">
            <div className="l-hero-copy">
              <span className="eyebrow rise" style={{ "--i": 0 } as React.CSSProperties}><i aria-hidden="true" />x402 · NEAR Intents · USDC on NEAR</span>
              <h1 id="hero-h" className="rise" style={{ "--i": 1 } as React.CSSProperties}>Let any agent pay you, <em>from any chain.</em></h1>
              <p className="l-sub rise" style={{ "--i": 2 } as React.CSSProperties}>Penstock puts an x402 paywall in front of any API or MCP tool. Agents pay with any token; you receive USDC on NEAR, with books that close.</p>
              <div className="l-actions rise" style={{ "--i": 3 } as React.CSSProperties}>
                <a className="btn btn-primary" href="/app">Open the demo console</a>
                <a className="btn btn-ghost" href="#how">How it works</a>
              </div>
              <p className="l-note mono rise" style={{ "--i": 4 } as React.CSSProperties}>{STATIC_DEMO ? "This hosted demo runs in your browser on simulated data, except the real mainnet transactions." : "The demo runs locally with simulated payments: no keys, no funds, no network."} <a href="#real">See the real payment and refund →</a></p>
            </div>
            <figure className="l-hero-art rise" style={{ "--i": 2 } as React.CSSProperties}>
              <HeroStage />
              <figcaption className="mono"><span><i aria-hidden="true" />6 chains in</span><span>1 gate</span><span>1 account out · USDC on NEAR</span></figcaption>
            </figure>
          </section>

          <section className="l-works" aria-labelledby="works-h">
            <h2 id="works-h" className="l-works-label mono">Works with</h2>
            <ul>
              {WORKS.map((w) => (
                <li key={w.name}>
                  <span className={`wm ${w.cls}`}>{w.name}</span>
                  <span className="l-works-role">{w.role}</span>
                  <span className="chip">{w.code}</span>
                </li>
              ))}
            </ul>
          </section>

          <Section id="instruments" eyebrow="Instruments" title="Four instruments. One console." intro="Each one is a tab in the seller console, and each one is working in the demo right now.">
            <div className="cards">
              {INSTRUMENTS.map((c, i) => (
                <article className="card" key={c.id} style={{ "--i": i } as React.CSSProperties}>
                  <div className="card-art" aria-hidden="true"><CardArt kind={c.id} /></div>
                  <span className="card-n mono">0{i + 1}</span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                  <a href={c.href} className="card-link">{c.cta} <span aria-hidden="true">→</span></a>
                </article>
              ))}
            </div>
          </Section>

          <Section eyebrow="From the demo ledger" title="What the demo has seen" intro="Read live from the seeded demo ledger when the demo is running. None of these are real transactions.">
            <Proof />
          </Section>

          <RealSection />

          <Section id="payment" eyebrow="How a payment works" title="One request, one 402, one payment from anywhere" intro="The agent never needs USDC on NEAR. It pays from the chain and token it already holds; NEAR Intents delivers USDC to the seller, and the retried request returns 200 with a signed receipt.">
            <PaymentReplay />
          </Section>

          <Section id="how" eyebrow="How it works" title="Every payment runs the same checklist" intro="An agent calls your endpoint and gets HTTP 402 with every chain you accept. It pays from whatever it holds. You receive USDC on NEAR and the call goes through, but only after these checks pass.">
            <ul className="checklist">
              {CHECKS.map((c) => (
                <li key={c.title}>
                  <svg viewBox="0 0 20 20" className="check" aria-hidden="true"><circle cx="10" cy="10" r="9" /><path d="M6 10.4l2.6 2.6L14.2 7.4" /></svg>
                  <div>
                    <h3>{c.title}</h3>
                    <p>{c.body}</p>
                  </div>
                  <span className="chip">{c.code}</span>
                </li>
              ))}
            </ul>
          </Section>

          <section className="l-cta" aria-labelledby="cta-h">
            <h2 id="cta-h">See it work in one command.</h2>
            <p><code className="inline">pnpm demo</code> starts the paywall, the console and a simulated buyer agent paying from different chains.</p>
            <div className="l-actions">
              <a className="btn btn-primary" href="/app">Open the demo console</a>
              <a className="btn btn-ghost" href={REPO}>Read the source</a>
            </div>
          </section>
        </div>
      </main>

      <footer className="l-foot">
        <div className="frame l-foot-grid">
          <div>
            <Wordmark size={22} />
            <p className="faint">Get paid by AI agents from any chain. Built for NEAR HACKATHON 2026. MIT licensed.</p>
          </div>
          <nav aria-label="Product">
            <h3>Product</h3>
            <a href="/app">Seller console</a>
            <a href="/app#/payments">Payments and receipts</a>
            <a href="/app#/funnel">Funnel</a>
          </nav>
          <nav aria-label="Docs">
            <h3>Docs</h3>
            <a href={`${REPO}#readme`}>README</a>
            <a href={`${REPO}/blob/main/docs/SPEC-NOTES.md`}>Spec notes</a>
            <a href={`${REPO}/blob/main/docs/AUDIT.md`}>Audit</a>
          </nav>
          <nav aria-label="Source">
            <h3>Source</h3>
            <a href={REPO}>GitHub</a>
            <a href={`${REPO}/blob/main/LICENSE`}>License (MIT)</a>
            <a href="https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api">1Click Swap API docs</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
