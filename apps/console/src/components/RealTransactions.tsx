import { short } from "../format";
import type { Proof, ProofEntry } from "../proof";
import { RealBadge } from "./OnChain";

const time = (iso: string) => `${iso.slice(11, 19)} UTC`;
const usdc = (s?: string) => (s ? `${s} USDC` : "—");

function Amounts({ e, seller }: { e: ProofEntry; seller: string }) {
  if (e.kind === "payment") {
    return (
      <dl className="real-amounts">
        <div><dt>Paid on Solana</dt><dd className="num">{usdc(e.paidUsdc)}</dd></div>
        <div><dt>Delivered on NEAR</dt><dd className="num">{usdc(e.deliveredUsdc)}<span className="faint"> to {seller}</span></dd></div>
        <div><dt>Fees</dt><dd className="num">{usdc(e.feesUsdc)}<span className="faint"> incl. storage registration</span></dd></div>
        <div><dt>Result</dt><dd>HTTP {e.http} · 1Click {e.oneClick.status}</dd></div>
      </dl>
    );
  }
  return (
    <dl className="real-amounts">
      <div><dt>Required</dt><dd className="num">{usdc(e.minAmountInUsdc)}</dd></div>
      <div><dt>Sent on Solana</dt><dd className="num">{usdc(e.sentUsdc)}<span className="faint"> (too little, on purpose)</span></dd></div>
      <div><dt>Refunded to payer</dt><dd className="num">{usdc(e.refundedUsdc)}<span className="faint"> (cost {usdc(e.refundCostUsdc)})</span></dd></div>
      <div><dt>Result</dt><dd>HTTP {e.http}, nothing released · 1Click {e.oneClick.status}</dd></div>
    </dl>
  );
}

/** The real payment and the real refund from proof.json, each step linked to its explorer. */
export function RealTransactions({ proof }: { proof: Proof }) {
  return (
    <div className="real-list">
      {proof.entries.map((e) => (
        <article className="panel real-entry" key={e.id} aria-labelledby={`${e.id}-h`}>
          <header className="real-entry-head">
            <div>
              <span className={`st ${e.kind === "payment" ? "st-settled" : "st-refunded"}`}>{e.kind === "payment" ? "payment" : "refund"}</span>
              <h3 id={`${e.id}-h`}>{e.title}</h3>
              <p className="faint mono real-meta">{e.date} · {e.endpoint} · price {e.priceUsdc} USDC</p>
            </div>
            <RealBadge />
          </header>
          <Amounts e={e} seller={proof.seller.account} />
          <ol className="real-steps">
            {e.steps.map((s) => (
              <li key={s.hash}>
                <span className="mono real-time">{time(s.at)}</span>
                <span className={`real-chain real-chain-${s.chain}`}>{s.chain === "solana" ? "Solana" : "NEAR"}</span>
                <span className="real-label">{s.label}</span>
                <a className="mono real-hash" href={s.url} title={s.hash}>{short(s.hash, 8)} <span aria-hidden="true">↗</span><span className="sr-only"> (opens {s.chain === "solana" ? "Solscan" : "NearBlocks"})</span></a>
              </li>
            ))}
          </ol>
          <p className="faint real-dep mono">deposit address {short(e.depositAddress, 8)} · 1Click {short(e.oneClick.correlationId, 8)}{e.oneClick.refundReason ? ` · ${e.oneClick.refundReason}` : ""}</p>
        </article>
      ))}
    </div>
  );
}
