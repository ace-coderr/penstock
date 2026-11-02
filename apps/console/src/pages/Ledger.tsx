import { useApi, type Overview, type Payment } from "../api";
import { Bars, Flow } from "../components/Flow";
import { Chain, Empty, ErrorState, Loading, Money, PageHead, Section, Sim, Status } from "../components/bits";
import { ago, money, moneyUsd, originAmount, pct } from "../format";
import { useCountUp, useNewIds } from "../motion";

export function Ledger({ overview }: { overview: Overview }) {
  const o = overview;
  const latest = useApi<{ payments: Payment[] }>("/payments?limit=8", 4000);
  const fresh = useNewIds(latest.data?.payments.map((p) => p.id));
  const received = useCountUp(Number(o.receivedUsdc));
  const simulated = o.simulation.settlement;
  return (
    <>
      <PageHead eyebrow="01 · Ledger" title="What came in, and from where" aside={<Sim on={simulated}>All figures simulated</Sim>}>
        Every payment below arrived as USDC in one NEAR account, whatever chain or token the agent paid with.
      </PageHead>
      <Section idx="01" title="Inflow, last 30 days">
        <div className="hero">
          <div className="panel">
            <div className="total-label">Received into your account</div>
            <div className="total num" aria-live="polite" aria-label={`${money(o.receivedUsdc)} USDC`}>{money(BigInt(Math.round(received)))}<small>USDC</small></div>
            <div className="into">→ {o.seller.nearAccount}</div>
            <dl className="facts">
              <dt>Revenue recognised</dt><dd><Money v={o.revenueUsdc} /></dd>
              <dt>Paid to upstream sellers</dt><dd><Money v={o.upstreamCostUsdc} /></dd>
              <dt>Session balance held</dt><dd><Money v={o.sessionFloatUsdc} /></dd>
              <dt>Route fees (paid by buyers)</dt><dd>{moneyUsd(o.buyerFeesUsd)}</dd>
            </dl>
          </div>
          <div className="flow-wrap">
            {o.byChain.length ? <Flow rows={o.byChain} account={o.seller.nearAccount} simulated={simulated} /> : <Empty title="No inflow yet">Payments will appear here as lines from each chain.</Empty>}
          </div>
        </div>
      </Section>

      <Section idx="02" title="At a glance">
        <div className="kpis">
          <div className="kpi"><div className="kpi-l">Payments</div><div className="kpi-v">{o.payments}</div><div className="kpi-s">{o.settled} settled</div></div>
          <div className="kpi"><div className="kpi-l">Chains paid from</div><div className="kpi-v">{o.byChain.length}</div><div className="kpi-s">one account receives</div></div>
          <div className="kpi"><div className="kpi-l">Probe → paid</div><div className="kpi-v">{pct(o.conversion)}</div><div className="kpi-s">{o.probes} probes</div></div>
          <div className="kpi"><div className="kpi-l">Refunds</div><div className="kpi-v">{o.refunds}</div><div className="kpi-s">returned by route to payer</div></div>
          <div className="kpi"><div className="kpi-l">Open sessions</div><div className="kpi-v">{o.openSessions}</div><div className="kpi-s">{money(o.sessionFloatUsdc)} held</div></div>
        </div>
      </Section>

      <Section idx="03" title="USDC received per day">
        <Bars daily={o.daily} />
      </Section>

      <Section idx="04" title="Latest payments" aside={<a href="#/payments">All payments →</a>}>
        {latest.loading && !latest.data ? <Loading /> : latest.error ? <ErrorState error={latest.error} onRetry={latest.reload} /> : !latest.data!.payments.length ? (
          <Empty title="No payments yet">Run <code>pnpm selftest http://localhost:4020/p/tidewater/tides</code> to make one.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Endpoint</th><th>Paid with</th><th className="r">Received</th><th>Status</th></tr></thead>
              <tbody>
                {latest.data!.payments.map((p) => (
                  <tr key={p.id} className={fresh.has(p.id) ? "row-new" : undefined}>
                    <td className="mono muted">{ago(p.ts)}</td>
                    <td className="mono">{p.endpointId.split(".")[1]}</td>
                    <td><Chain chain={p.originChain} /> <span className="mono muted">{originAmount(p.originChain, p.originSymbol, p.amountIn)}</span></td>
                    <td className="num r"><Money v={p.amountOut} kind="micro" /></td>
                    <td><Status value={p.status} /> <Sim on={p.simulated} /></td>
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
