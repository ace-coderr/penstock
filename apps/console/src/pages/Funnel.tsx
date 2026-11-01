import { useApi, type Funnel as F, type Stage } from "../api";
import { Chain, Empty, ErrorState, Loading, PageHead, Section } from "../components/bits";
import { ago } from "../format";

const LABEL: Record<string, string> = { probed: "Probed (got 402)", quoted: "Asked for a quote", deposited: "Deposited", paid: "Paid" };

function Stages({ stages }: { stages: Stage[] }) {
  const top = stages[0]?.count || 1;
  return (
    <div className="stages">
      {stages.map((s, i) => {
        const prev = i === 0 ? s.count : stages[i - 1]!.count;
        return (
          <div className="stage" key={s.stage}>
            <div className="stage-name">{LABEL[s.stage] ?? s.stage}</div>
            <div className="stage-track" aria-hidden="true"><div className="stage-fill" style={{ width: `${(s.count / top) * 100}%` }} /></div>
            <div className="stage-num">{s.count} <span>{i === 0 ? "buyers' visits" : `${prev ? Math.round((s.count / prev) * 100) : 0}% of previous`}</span></div>
          </div>
        );
      })}
    </div>
  );
}

export function Funnel({ days }: { days: number }) {
  const r = useApi<F>(`/funnel?days=${days}`);
  const head = (
    <PageHead eyebrow="03 · Funnel" title="Who probed, who paid, where they stopped">
      Every unpaid call is a probe. Reasons for stopping are inferred from what buyers did next, never stated by them.
    </PageHead>
  );
  if (r.loading && !r.data) return <>{head}<Loading lines={6} /></>;
  if (r.error) return <>{head}<ErrorState error={r.error} onRetry={r.reload} /></>;
  const f = r.data!;
  if (!f.stages[0]?.count) return <>{head}<Empty title="No probes yet">When an agent calls a paid endpoint without paying, it shows up here as a probe.</Empty></>;
  return (
    <>
      {head}
      <Section idx="01" title="Probe to purchase" aside={<span className="mono">{f.buyers} distinct buyers · {days} days</span>}>
        <p className="lede">Every unpaid call is a probe. This is how far buyers got before paying or leaving.</p>
        <Stages stages={f.stages} />
      </Section>

      <Section idx="02" title="Why buyers stopped" aside={<span className="inferred">Inferred</span>}>
        <p className="trust">{f.note} Buyers are identified by a keyed hash, never by IP address.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Inferred reason</th><th>Stopped at</th><th className="r">Buyers</th></tr></thead>
            <tbody>
              {f.inferredReasons.map((x) => (
                <tr key={x.stage + x.reason}><td>{x.reason}</td><td className="mono muted">{x.stage}</td><td className="num r">{x.count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section idx="03" title="By endpoint">
        <div className="grid-2">
          {f.byEndpoint.map((e) => {
            const top = e.stages[0]?.count || 1;
            return (
              <div className="mini" key={e.endpoint}>
                <h3>{e.endpoint.split(".")[1]}</h3>
                <div className="mini-bars" aria-label={e.stages.map((s) => `${s.stage} ${s.count}`).join(", ")}>
                  {e.stages.map((s) => <div key={s.stage} style={{ height: `${(s.count / top) * 100}%` }} title={`${s.stage}: ${s.count}`} />)}
                </div>
                <div className="mono muted" style={{ fontSize: 12, marginTop: 6 }}>{e.stages.map((s) => s.count).join(" → ")}</div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section idx="04" title="Recent probes">
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Buyer</th><th>Endpoint</th><th>Chain</th><th>Reached</th><th className="hide-sm">Inferred reason</th></tr></thead>
            <tbody>
              {f.recent.map((p, i) => (
                <tr key={i}>
                  <td className="mono muted">{ago(p.ts)}</td>
                  <td className="mono">{p.buyer}</td>
                  <td className="mono">{p.endpoint.split(".")[1]}</td>
                  <td>{p.chain ? <Chain chain={p.chain} /> : <span className="faint">—</span>}</td>
                  <td className="mono">{p.stage}</td>
                  <td className="muted hide-sm">{p.inferredReason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
