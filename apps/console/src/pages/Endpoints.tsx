import { useState, type FormEvent } from "react";
import { api, ApiError, STATIC_DEMO, useApi, type EndpointRow, type Shielded } from "../api";
import { PayoutCheck } from "../components/PayoutCheck";
import { Empty, ErrorState, Loading, Money, PageHead, Section } from "../components/bits";
import { money } from "../format";

function Protect({ onDone }: { onDone: () => void }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ url: string }>("/endpoints", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: f.get("slug"), upstreamUrl: f.get("upstream"), priceUsd: f.get("price"), description: f.get("description"), capabilities: String(f.get("caps") ?? "").split(",").map((s) => s.trim()).filter(Boolean), methods: ["GET", "POST"] }),
      });
      setMsg({ ok: true, text: `Protected. Agents now pay at ${r.url}` });
      (e.target as HTMLFormElement).reset();
      onDone();
    } catch (err) {
      setMsg({ ok: false, text: (err as ApiError).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} aria-describedby="protect-help">
      <p id="protect-help" className="lede">Put a paywall in front of any HTTP API. Requests are forwarded only to this exact upstream, and only after payment. Private, metadata and credentialed URLs are refused.</p>
      {STATIC_DEMO && <p className="banner" role="note"><span className="sim">Hosted demo</span> Protecting an endpoint needs the Penstock proxy. Run it locally (<code className="inline">pnpm demo</code>) to try this form.</p>}
      <fieldset className="plain-fieldset" disabled={STATIC_DEMO}>
      <div className="form-grid">
        <div className="field"><label htmlFor="p-slug">Slug</label><input id="p-slug" name="slug" required pattern="[a-z0-9][a-z0-9\-]{0,59}" placeholder="fx-rates" /></div>
        <div className="field wide"><label htmlFor="p-up">Upstream URL</label><input id="p-up" name="upstream" required type="url" placeholder="https://api.example.com/v1/fx" /></div>
        <div className="field"><label htmlFor="p-price">Price per call (USD)</label><input id="p-price" name="price" required inputMode="decimal" pattern="\d+(\.\d{1,6})?" placeholder="0.005" /></div>
        <div className="field wide"><label htmlFor="p-desc">What it returns</label><input id="p-desc" name="description" maxLength={200} placeholder="Mid-market FX rates for 30 currencies" /></div>
        <div className="field"><label htmlFor="p-caps">Capabilities</label><input id="p-caps" name="caps" placeholder="fx, rates" /></div>
        <div className="field"><button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Protect endpoint"}</button></div>
      </div>
      </fieldset>
      {msg && <p className={`msg ${msg.ok ? "msg-ok" : "msg-bad"}`} role="status">{msg.text}</p>}
    </form>
  );
}

function ShieldedPanel() {
  const r = useApi<Shielded>("/shielded");
  if (r.loading && !r.data) return <Loading lines={3} />;
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  const s = r.data!;
  return (
    <>
      <p className="lede">Shielded-payer mode hides who paid you and from where. It is optional: with every route off, payments are public and everything else works.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Route</th><th>State</th><th>Why</th></tr></thead>
          <tbody>
            {s.routes.map((x) => (
              <tr key={x.id}>
                <td className="mono">{x.label}</td>
                <td><span className={`st ${x.enabled ? "st-settled" : "st-pending"}`}>{x.enabled ? "enabled" : "not enabled"}</span></td>
                <td className="wrap">{x.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.scope && (
        <p className="trust" style={{ marginTop: 16 }}>
          <strong>Hides:</strong> {s.scope.hides}<br /><strong>Does not hide:</strong> {s.scope.doesNotHide}
          <br /><span className="mono">{s.shieldedPayments} shielded payments in the ledger</span>
        </p>
      )}
    </>
  );
}

export function Endpoints() {
  const r = useApi<{ endpoints: EndpointRow[] }>("/endpoints");
  return (
    <>
      <PageHead eyebrow="05 · Endpoints" title="What you sell, and where it pays out">
        Each endpoint is an upstream you protect, a price per call, and the NEAR account that receives the USDC.
      </PageHead>
      <Section idx="01" title="Protected endpoints">
        {r.loading && !r.data ? <Loading /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data!.endpoints.length ? (
          <Empty title="Nothing protected yet">Add your first endpoint below.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Endpoint</th><th>Kind</th><th className="r">Price</th><th className="hide-sm">Upstream</th><th>Sessions</th><th className="r">Calls (30d)</th><th className="r">Margin / call</th></tr></thead>
              <tbody>
                {r.data!.endpoints.map((e) => (
                  <tr key={e.id}>
                    <td><span className="mono">{e.slug}</span><div className="faint mono" style={{ fontSize: 12 }}>{e.url}</div></td>
                    <td className="mono muted">{e.kind}{e.resaleOf.length ? " · resale" : ""}</td>
                    <td className="num r"><Money v={e.priceUsdc} kind="micro" /></td>
                    <td className="mono muted hide-sm">{e.upstreamHost}</td>
                    <td className="mono">{e.sessionsEnabled ? "on" : "—"}</td>
                    <td className="num r">{e.calls}</td>
                    <td className="num r">{e.marginPerCallUsdc ? <Money v={e.marginPerCallUsdc} kind="micro" /> : "—"}{e.resaleOf.length > 0 && e.marginPerCallUsdc && <div className="faint" style={{ fontSize: 12 }}>after {money(BigInt(e.upstreamCostUsdc) / BigInt(Math.max(1, e.calls)), "micro")} upstream</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section idx="02" title="Protect an endpoint"><div className="panel"><Protect onDone={r.reload} /></div></Section>
      <div className="grid-2 sec-pair">
        <Section idx="03" title="Payout account check"><div className="panel"><PayoutCheck /></div></Section>
        <Section idx="04" title="Shielded payer routes"><div className="panel"><ShieldedPanel /></div></Section>
      </div>
    </>
  );
}
