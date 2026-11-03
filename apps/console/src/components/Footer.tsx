import { STATIC_DEMO } from "../api";
import { Wordmark } from "./Wordmark";

export const REPO = "https://github.com/ace-coderr/penstock";

/** The one footer, on the landing page and on every console tab. */
export function Footer() {
  return (
    <footer className="l-foot">
      <div className="frame l-foot-grid">
        <div className="l-foot-brand">
          <Wordmark size={22} />
          <p className="faint">Get paid by AI agents from any chain. Built for NEAR HACKATHON 2026. MIT licensed.</p>
          <p className="l-foot-note">
            {STATIC_DEMO
              ? "This hosted demo is simulated, except the Real (on-chain) view and the real transactions, which are read from NEAR and Solana mainnet."
              : "Demo and dry modes use simulated settlement, except the Real (on-chain) view, which is read from NEAR mainnet."}
          </p>
        </div>
        <nav aria-label="Product">
          <h3>Product</h3>
          <a href="/app">Seller console</a>
          <a href="/app#/?view=real">Real (on-chain) view</a>
          <a href="/app#/payments">Payments and receipts</a>
          <a href="/app#/endpoints">Payout account check</a>
        </nav>
        <nav aria-label="Proof">
          <h3>Proof</h3>
          <a href="/#real">Real transactions</a>
          <a href={`${REPO}/blob/main/docs/PROOF.md`}>PROOF.md</a>
          <a href="/proof.json">proof.json</a>
          <a href={`${REPO}/blob/main/docs/AUDIT.md`}>Audit</a>
        </nav>
        <nav aria-label="Docs">
          <h3>Docs</h3>
          <a href={`${REPO}#readme`}>README</a>
          <a href={`${REPO}/blob/main/docs/LIVE-RUNBOOK.md`}>Live runbook</a>
          <a href={`${REPO}/blob/main/docs/SPEC-NOTES.md`}>Spec notes</a>
          <a href="https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api">1Click Swap API docs</a>
        </nav>
        <nav aria-label="Source">
          <h3>Source</h3>
          <a href={REPO}>GitHub</a>
          <a href={`${REPO}/blob/main/LICENSE`}>License (MIT)</a>
        </nav>
      </div>
    </footer>
  );
}
