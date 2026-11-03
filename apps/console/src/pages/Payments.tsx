import { useState } from "react";
import { downloadCsv, exportUrl, STATIC_DEMO, useApi, type Payment, type Receipt } from "../api";
import { Chain, Drawer, Empty, ErrorState, Loading, Money, PageHead, Section, Sim, Status } from "../components/bits";
import { CHAIN_META, explorerFor, isSimHash, originAmount, short, money, moneyUsd, when } from "../format";
import { useNewIds } from "../motion";
import { RealView } from "../components/RealView";
import { ViewSwitch, useView } from "../components/ViewSwitch";

const PAGE = 25;

function Hash({ chain, value }: { chain: string; value: string | null }) {
  if (!value) return <>—</>;
  const href = explorerFor(chain, value);
  return (
    <>
      {href ? <a href={href} target="_blank" rel="noreferrer noopener">{value}</a> : value}
      {isSimHash(value) && <> <span className="sim-inline">simulated</span></>}
    </>
  );
}

function ReceiptView({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useApi<{ payment: Payment; receipt: Receipt; receiptValid: boolean | null; upstreamReceipts?: (Receipt & { valid: boolean })[] }>(`/payments/${id}`);
  return (
    <Drawer title={`Receipt ${id}`} onClose={onClose}>
      {r.loading && !r.data ? <Loading lines={8} /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : (() => {
        const { payment: p, receipt, receiptValid, upstreamReceipts = [] } = r.data!;
        return (
          <>
            <div className="receipt-head">
              <div>
                <div className="total-label">{p.status === "settled" ? "You received" : p.status === "refunded" ? "Refunded to the payer" : "Payment"}</div>
                <div className="receipt-amount">{p.status === "settled" ? <Money v={p.amountOut} kind="micro" /> : originAmount(p.originChain, p.originSymbol, p.refundedAmount ?? p.amountIn)}<small>{p.status === "settled" ? "USDC" : ""}</small></div>
              </div>
              <Status value={p.status} />
            </div>
            {p.simulated && <div className="banner"><span className="sim">Simulated</span> This payment was simulated. No funds moved and the hashes are not on any chain.</div>}
            <dl className="kv">
              <dt>Status</dt><dd><Status value={p.status} /></dd>
              <dt>Time</dt><dd>{when(p.ts)}</dd>
              <dt>Endpoint</dt><dd>{p.endpointId}</dd>
              <dt>Method</dt><dd>{p.method === "near-intents" ? "near-intents (any chain → USDC on NEAR)" : p.method === "exact-near" ? "exact on NEAR (direct USDC)" : p.method}</dd>
              <dt>You received</dt><dd><Money v={p.amountOut} kind="micro" /> USDC</dd>
              <dt>Buyer paid</dt><dd>{originAmount(p.originChain, p.originSymbol, p.amountIn)} on {CHAIN_META[p.originChain]?.label ?? p.originChain} (≈ {moneyUsd(p.amountInUsd, "micro")})</dd>
              <dt>Route fee</dt><dd><span title={`$${p.feeUsd.toFixed(6)}`}>{moneyUsd(p.feeUsd, "micro")}</span> <span className="muted">paid by the buyer</span></dd>
              {p.upstreamCost !== "0" && <><dt>Upstream cost</dt><dd><Money v={p.upstreamCost} kind="micro" /> (resale)</dd></>}
              <dt>Payer</dt><dd>{p.payer}</dd>
              {p.depositAddress && <><dt>Deposit address</dt><dd>{p.depositAddress}</dd></>}
              <dt>Origin tx</dt><dd><Hash chain={p.originChain} value={p.originTx} /></dd>
              <dt>Settlement tx (NEAR)</dt><dd><Hash chain="near" value={p.destTx} /></dd>
              {p.status === "refunded" && <><dt>Refund</dt><dd>{p.refundedAmount ? originAmount(p.originChain, p.originSymbol, p.refundedAmount) : "—"} to {p.refundTo} ({p.refundReason})</dd></>}
              {p.sessionId && <><dt>Session</dt><dd>{p.sessionId}</dd></>}
              {p.shielded && <><dt>Payer route</dt><dd>shielded (origin wallet not linked)</dd></>}
            </dl>
            {upstreamReceipts.length > 0 && (
              <div className="sig">
                <span className="muted">Resale: bought from {upstreamReceipts.length} upstream sellers for {money(p.upstreamCost, "micro")}; margin {money(BigInt(p.amountOut) - BigInt(p.upstreamCost), "micro")}</span>
                <dl className="kv" style={{ marginTop: 10 }}>
                  {upstreamReceipts.map((u) => (
                    <div key={u.sig} style={{ display: "contents" }}>
                      <dt>{String(u.body.endpoint)}</dt>
                      <dd><Money v={String(u.body.amountUsdc ?? "0")} kind="micro" /> to {String(u.body.seller)} · {u.valid ? <span className="msg-ok">✓ signed</span> : <span className="msg-bad">✗ invalid</span>}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            <div className="sig">
              {receiptValid === null ? (
                <span className="muted">Generated in your browser by the hosted demo: simulated, not signed.</span>
              ) : (
                <>
                  <span className={receiptValid ? "msg-ok" : "msg-bad"}>{receiptValid ? "✓ Signature valid" : "✗ Signature does not verify"}</span>
                  <span className="muted"> · ed25519 · key {short(receipt.pub, 8)}{STATIC_DEMO ? " · signed when this hosted demo was built" : ""}</span>
                </>
              )}
              <pre>{JSON.stringify(receipt.body, null, 2)}</pre>
            </div>
          </>
        );
      })()}
    </Drawer>
  );
}

export function Payments({ days }: { days: number }) {
  const [view, setView] = useView();
  return (
    <>
      <ViewSwitch view={view} onChange={setView} />
      {view === "real" ? <RealView tab="payments" /> : <SimulatedPayments days={days} />}
    </>
  );
}

function SimulatedPayments({ days }: { days: number }) {
  const [status, setStatus] = useState("");
  const [chain, setChain] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const q = `/payments?limit=${PAGE}&offset=${page * PAGE}${status ? `&status=${status}` : ""}${chain ? `&chain=${chain}` : ""}`;
  const r = useApi<{ total: number; payments: Payment[] }>(q, page === 0 ? 4000 : undefined);
  const fresh = useNewIds(r.data?.payments.map((p) => p.id));
  const pages = r.data ? Math.max(1, Math.ceil(r.data.total / PAGE)) : 1;
  return (
    <>
    <PageHead eyebrow="02 · Payments" title="Every payment, receipt and refund" aside={STATIC_DEMO
      ? <button type="button" className="btn btn-primary" onClick={() => void downloadCsv(days)}>Export CSV ({days} days)</button>
      : <a className="btn btn-primary" href={exportUrl(days)} download>Export CSV ({days} days)</a>}>
      Open any row for its signed receipt. Refunds are returned by the route to the payer's own address.
    </PageHead>
    <Section idx="01" title="Ledger entries" aside={r.data ? <span className="mono">{r.data.total} entries</span> : null}>
      <div className="toolbar">
        <div className="field">
          <span className="lbl" id="f-status-l">Status</span>
          <div className="seg" role="group" aria-labelledby="f-status-l">
            {[["", "All"], ["settled", "Settled"], ["refunded", "Refunds"], ["pending", "Pending"]].map(([v, l]) => (
              <button key={v} type="button" aria-pressed={status === v} onClick={() => { setStatus(v!); setPage(0); }}>{l}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="f-chain">Paid from</label>
          <select id="f-chain" value={chain} onChange={(e) => { setChain(e.target.value); setPage(0); }}>
            <option value="">Any chain</option>
            {Object.entries(CHAIN_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
        </div>
      </div>
      {r.loading && !r.data ? <Loading lines={8} /> : r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data!.payments.length ? (
        status === "refunded" ? (
          <Empty title="No refunds">No payment was refunded in this period{chain ? " from this chain" : ""}. When a route fails or a deposit is short, 1Click returns the funds to the payer and the refund shows up here.</Empty>
        ) : (
          <Empty title="Nothing matches">No payments for these filters. Clear them, or make one with <code>pnpm selftest http://localhost:4020/p/tidewater/tides</code>.</Empty>
        )
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Receipt</th><th>When</th><th>Endpoint</th><th>Paid with</th><th className="r">Received</th><th className="r hide-sm">Route fee</th><th>Status</th><th className="hide-sm">Method</th></tr>
              </thead>
              <tbody>
                {r.data!.payments.map((p) => (
                  <tr key={p.id} className={fresh.has(p.id) ? "row-new" : undefined}>
                    <td><button className="row-btn" onClick={() => setOpen(p.id)} aria-label={`Open receipt ${p.id}`}>{p.id.slice(0, 12)}</button></td>
                    <td className="mono muted">{when(p.ts)}</td>
                    <td className="mono">{p.endpointId.split(".")[1]}{p.sessionId && <span className="faint"> · session</span>}</td>
                    <td><Chain chain={p.originChain} /> <span className="mono muted">{originAmount(p.originChain, p.originSymbol, p.amountIn)}</span></td>
                    <td className="num r">{p.status === "settled" ? <Money v={p.amountOut} kind="micro" /> : <span className="faint">{money("0", "micro")}</span>}</td>
                    <td className="num r hide-sm muted"><span title={`$${p.feeUsd.toFixed(6)}`}>{moneyUsd(p.feeUsd, "micro")}</span></td>
                    <td><Status value={p.status} /> <Sim on={p.simulated} /></td>
                    <td className="mono muted hide-sm">{p.method}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button className="btn" disabled={page === 0} onClick={() => setPage((x) => x - 1)}>Previous</button>
            <span>page {page + 1} / {pages}</span>
            <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage((x) => x + 1)}>Next</button>
          </div>
        </>
      )}
      {open && <ReceiptView id={open} onClose={() => setOpen(null)} />}
    </Section>
    </>
  );
}
