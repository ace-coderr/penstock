import { useApi, type Session } from "../api";
import { Chain, Empty, ErrorState, Loading, PageHead, Section, Sim, Status } from "../components/bits";
import { ago, short, usdc } from "../format";

export function Sessions({ live }: { live: boolean }) {
  const r = useApi<{ capUsdc: string; sessions: Session[] }>("/sessions");
  const head = (
    <PageHead eyebrow="04 · Sessions" title="Prepaid balances for micro-calls">
      Bridges have minimums, so small calls are paid from a session funded once and metered per call.
    </PageHead>
  );
  if (r.loading && !r.data) return <>{head}<Loading lines={6} /></>;
  if (r.error) return <>{head}<ErrorState error={r.error} onRetry={r.reload} /></>;
  const { capUsdc, sessions } = r.data!;
  const owed = sessions.filter((s) => s.refundState === "owed");
  return (
    <>
    {head}
    <Section idx="01" title="Sessions" aside={<span className="mono">cap {usdc(capUsdc, 2)} per session</span>}>
      <p className="trust">
        One payment opens a session; calls are metered against it and settled in batches; the unused balance is refunded on close or after 24 hours.
        You hold session funds (never more than the cap) until close. The buyer holds a signed session receipt the whole time.
      </p>
      {live && owed.length > 0 && (
        <div className="banner banner-bad">
          <strong>{owed.length} refund{owed.length > 1 ? "s" : ""} owed.</strong> Penstock holds no keys: send each unused balance below from your NEAR account.
        </div>
      )}
      {!sessions.length ? <Empty title="No sessions yet">Open one with <code>POST /s/tidewater/tides/open/2000000</code> (pays $2 for 500 calls).</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Session</th><th>Opened</th><th>Endpoint</th><th>Funded from</th><th className="r">Funded</th><th className="r">Spent</th><th className="r">Refund</th><th>State</th><th className="hide-sm">Refund to</th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.id}</td>
                  <td className="mono muted">{ago(s.openedAt)}</td>
                  <td className="mono">{s.endpointId.split(".")[1]}</td>
                  <td><Chain chain={s.originChain} /></td>
                  <td className="num r">{usdc(s.fundedUsdc)}</td>
                  <td className="num r">{usdc(s.spentUsdc)}</td>
                  <td className="num r">{s.refundUsdc ? usdc(s.refundUsdc) : <span className="faint">open</span>}</td>
                  <td><Status value={s.status} /> {s.refundState && s.refundState !== "none" && <Status value={s.refundState} />} <Sim on={s.simulated} /></td>
                  <td className="mono muted hide-sm">{short(s.refundTo, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
    </>
  );
}
