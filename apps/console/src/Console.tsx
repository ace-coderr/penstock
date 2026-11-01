import { useEffect, useRef, useState } from "react";
import { adminToken, setAdminToken, useApi, type Overview, type Payment } from "./api";
import { CHAIN_META, usdc } from "./format";
import { ErrorState, Loading } from "./components/bits";
import { Wordmark } from "./components/Wordmark";
import { Endpoints } from "./pages/Endpoints";
import { Funnel } from "./pages/Funnel";
import { Ledger } from "./pages/Ledger";
import { Payments } from "./pages/Payments";
import { Sessions } from "./pages/Sessions";

/** Seller console at /app. Tabs are hash routes (/app#/payments) so a reload keeps the tab. */

export const ROUTES = [
  { path: "", label: "Ledger", hint: "What came in, and from where" },
  { path: "payments", label: "Payments", hint: "Every payment, receipt and refund" },
  { path: "funnel", label: "Funnel", hint: "Who probed, who paid, where they stopped" },
  { path: "sessions", label: "Sessions", hint: "Prepaid balances for micro-calls" },
  { path: "endpoints", label: "Endpoints", hint: "What you sell, payout account, privacy" },
] as const;

function useRoute(): string {
  const read = () => location.hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => setR(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

function TokenField() {
  const [v, setV] = useState(adminToken());
  return (
    <label className="pill" title="Only needed when the proxy runs with ADMIN_TOKEN">
      <span className="sr-only">Admin token</span>
      <input aria-label="Admin token" type="password" placeholder="admin token" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => setAdminToken(v)} />
    </label>
  );
}

interface Toast {
  id: string;
  text: string;
  detail: string;
}

/** Shows a short notice when a new payment lands (in the demo: a simulated agent paying). */
function useArrivalToasts(): Toast[] {
  const latest = useApi<{ payments: Payment[] }>("/payments?limit=1", 4000);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastId = useRef<string | null>(null);
  const p = latest.data?.payments[0];
  useEffect(() => {
    if (!p) return;
    if (lastId.current === null) {
      lastId.current = p.id;
      return;
    }
    if (p.id === lastId.current) return;
    lastId.current = p.id;
    const chain = CHAIN_META[p.originChain]?.label ?? p.originChain;
    const t: Toast = {
      id: p.id,
      text: `${p.simulated ? "Simulated agent paid" : "Payment received"}: ${usdc(p.amountOut)}`,
      detail: `${p.endpointId.split(".")[1]} · from ${p.originSymbol} on ${chain}${p.sessionId ? " · session" : ""}`,
    };
    setToasts((xs) => [...xs.slice(-2), t]);
    // Each toast owns its timer; a newer arrival must not cancel an older toast's dismissal.
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== t.id)), 4500);
  }, [p]);
  return toasts;
}

export function Console() {
  const route = useRoute();
  const days = 30;
  const o = useApi<Overview>(`/overview?days=${days}`, 5000);
  const toasts = useArrivalToasts();
  const ov = o.data;
  const current = ROUTES.find((r) => r.path === route) ?? ROUTES[0];
  useEffect(() => {
    document.title = `${current.label} · Penstock console`;
  }, [current.label]);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="frame">
          <div className="top-row">
            <a className="mark" href="/" aria-label="Penstock home">
              <Wordmark size={22} />
              <span className="mark-sub">{ov ? ov.seller.name : "seller console"}</span>
            </a>
            <div className="top-right">
              {ov && (
                <span className={`pill ${ov.account.exists === false ? "pill-bad" : "pill-ok"}`} title={ov.account.message}>
                  <span className={`dot ${ov.account.exists === false ? "dot-bad" : ov.account.exists ? "dot-ok" : "dot-warn"}`} />
                  {ov.seller.nearAccount}
                </span>
              )}
              {ov && ov.mode !== "live" && <span className="sim">{ov.mode} · simulated</span>}
              {ov && ov.mode === "live" && <span className="pill"><span className="dot dot-ok" />live · mainnet</span>}
              <TokenField />
            </div>
          </div>
          <nav className="nav" aria-label="Console sections">
            {ROUTES.map((r, i) => (
              <a key={r.path} href={`#/${r.path}`} aria-current={current.path === r.path ? "page" : undefined}>
                <span className="n">0{i + 1}</span>{r.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <div className="frame">
        <main id="main" className="console" tabIndex={-1}>
          {ov && ov.simulation.settlement && (
            <div className="banner" role="note"><span className="sim">Simulated</span> {ov.simulation.label} Every row marked “simulated” is demo data, not a real transaction.</div>
          )}
          {ov && ov.account.exists === false && (
            <div className="banner banner-bad" role="alert"><strong>Payout account problem.</strong> {ov.account.message} Quotes are refused until this is fixed.</div>
          )}
          {o.loading && !ov ? <Loading lines={8} /> : o.error && !ov ? <ErrorState error={o.error} onRetry={o.reload} /> : ov && (
            <div className="view" key={current.path}>
              {route === "payments" ? <Payments days={days} /> :
                route === "funnel" ? <Funnel days={days} /> :
                route === "sessions" ? <Sessions live={ov.mode === "live"} /> :
                route === "endpoints" ? <Endpoints account={ov.account} /> :
                <Ledger overview={ov} />}
            </div>
          )}
        </main>
      </div>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div className="toast" key={t.id}>
            <span className="dot dot-ok dot-live" aria-hidden="true" />
            <div><strong>{t.text}</strong><span className="faint">{t.detail}</span></div>
          </div>
        ))}
      </div>
    </>
  );
}
