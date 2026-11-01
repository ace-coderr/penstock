import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import { adminToken, setAdminToken, useApi, type Overview } from "./api";
import { ErrorState, Loading } from "./components/bits";
import { Endpoints } from "./pages/Endpoints";
import { Funnel } from "./pages/Funnel";
import { Ledger } from "./pages/Ledger";
import { Payments } from "./pages/Payments";
import { Sessions } from "./pages/Sessions";

const ROUTES = [
  { path: "", label: "Ledger" },
  { path: "payments", label: "Payments" },
  { path: "funnel", label: "Funnel" },
  { path: "sessions", label: "Sessions" },
  { path: "endpoints", label: "Endpoints" },
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

function Glyph() {
  // A penstock in section: many intakes, one pipe, one outlet.
  return (
    <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden="true">
      <path d="M1 3 C8 3 9 10 15 10 M1 10 H15 M1 17 C8 17 9 10 15 10" stroke="#5ed1c2" strokeWidth="1.6" fill="none" />
      <rect x="15" y="6.5" width="10" height="7" rx="1.5" fill="none" stroke="#e9e4d8" strokeWidth="1.4" />
    </svg>
  );
}

function TokenField() {
  const [v, setV] = useState(adminToken());
  return (
    <label className="pill" title="Only needed when the proxy runs with ADMIN_TOKEN">
      <span className="sr-only">Admin token</span>
      <input
        aria-label="Admin token"
        type="password"
        placeholder="admin token"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { setAdminToken(v); }}
        style={{ background: "transparent", border: 0, width: 110, outline: "none" }}
      />
    </label>
  );
}

function App() {
  const route = useRoute();
  const days = 30;
  const o = useApi<Overview>(`/overview?days=${days}`);
  const ov = o.data;
  const title = ROUTES.find((r) => r.path === route)?.label ?? "Ledger";
  useEffect(() => {
    document.title = `${title} · Penstock`;
  }, [title]);

  return (
    <>
      <header className="top">
        <div className="top-row">
          <a className="mark" href="#/">
            <Glyph />
            <span>
              <span className="mark-word">PENSTOCK</span>
              <br />
              <span className="mark-sub">{ov ? ov.seller.name : "seller console"}</span>
            </span>
          </a>
          <div className="top-right">
            {ov && (
              <span className={`pill ${ov.account.exists === false ? "pill-bad" : "pill-ok"}`} title={ov.account.message}>
                <span className={`dot ${ov.account.exists === false ? "dot-bad" : ov.account.exists ? "dot-ok" : "dot-warn"}`} />
                {ov.seller.nearAccount}
              </span>
            )}
            {ov && ov.mode !== "live" && <span className="sim">{ov.mode} mode · simulated</span>}
            {ov && ov.mode === "live" && <span className="pill"><span className="dot dot-ok" />live · mainnet</span>}
            <TokenField />
          </div>
        </div>
        <nav className="nav" aria-label="Sections">
          {ROUTES.map((r, i) => (
            <a key={r.path} href={`#/${r.path}`} aria-current={route === r.path ? "page" : undefined}>
              <span className="n">0{i + 1}</span>{r.label}
            </a>
          ))}
        </nav>
      </header>
      <main id="main">
        {ov && ov.simulation.settlement && (
          <div className="banner" role="note"><span className="sim">Simulated</span> {ov.simulation.label} Every row marked “simulated” is demo data, not a real transaction.</div>
        )}
        {ov && ov.account.exists === false && (
          <div className="banner banner-bad" role="alert"><strong>Payout account problem.</strong> {ov.account.message} Quotes are refused until this is fixed.</div>
        )}
        {o.loading && !ov ? <Loading lines={8} /> : o.error ? <ErrorState error={o.error} onRetry={o.reload} /> : ov && (
          route === "payments" ? <Payments days={days} /> :
          route === "funnel" ? <Funnel days={days} /> :
          route === "sessions" ? <Sessions live={ov.mode === "live"} /> :
          route === "endpoints" ? <Endpoints account={ov.account} /> :
          <Ledger overview={ov} />
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
