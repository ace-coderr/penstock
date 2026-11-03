import { useEffect, useId, useState } from "react";
import { money, short, when } from "../format";
import type { SignedReceipt } from "../proof";
import { parseReceipt, verifyReceipt, type Verdict } from "../verify";

const explorer = (field: string, v: string, origin?: string) =>
  field === "transaction" ? `https://nearblocks.io/txns/${v}`
  : field === "originTx" && origin === "sol" ? `https://solscan.io/tx/${v}`
  : field === "seller" ? `https://nearblocks.io/address/${v}`
  : null;

function Fields({ r }: { r: SignedReceipt }) {
  const b = r.body;
  const rows: [string, unknown][] = Object.entries(b);
  return (
    <dl className="receipt-fields">
      {rows.map(([k, v]) => {
        const s = String(v);
        const href = typeof v === "string" ? explorer(k, s, String(b.originChain)) : null;
        const shown = k === "amountUsdc" ? `${money(s, "micro")} (${s} base units)` : k === "ts" && typeof v === "number" ? `${when(v)} (${s})` : s;
        return (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono">{href ? <a href={href} title={s}>{short(s, 14)}</a> : <span title={s}>{s.length > 40 ? short(s, 16) : shown}</span>}</dd>
          </div>
        );
      })}
      <div><dt>pub (ed25519)</dt><dd className="mono" title={r.pub}>{short(r.pub, 12)}</dd></div>
    </dl>
  );
}

function VerdictLine({ v }: { v: Verdict | null }) {
  if (!v) return <p className="verdict" aria-live="polite">Checking the signature…</p>;
  return v.valid
    ? <p className="verdict verdict-ok" aria-live="polite"><span aria-hidden="true">✓</span> Signature valid: ed25519 over the canonical JSON of the body, checked in your browser.</p>
    : <p className="verdict verdict-bad" aria-live="polite"><span aria-hidden="true">✗</span> Not valid: {v.reason}.</p>;
}

/** Verifies the real receipt on load, and any receipt someone pastes. */
export function ReceiptVerifier({ receipt }: { receipt: SignedReceipt }) {
  const [v, setV] = useState<Verdict | null>(null);
  const [text, setText] = useState("");
  const [pasted, setPasted] = useState<{ r: SignedReceipt | null; v: Verdict | null } | null>(null);
  const id = useId();
  useEffect(() => {
    let live = true;
    void verifyReceipt(receipt).then((x) => live && setV(x));
    return () => {
      live = false;
    };
  }, [receipt]);
  const check = async () => {
    const r = parseReceipt(text);
    setPasted({ r, v: null });
    setPasted({ r, v: r ? await verifyReceipt(r) : { valid: false, reason: "that is not a Penstock receipt (paste the JSON or the PENSTOCK-RECEIPT header value)" } });
  };
  return (
    <div className="receipt-verifier">
      <div className="panel">
        <div className="total-label">Signed receipt for the real payment</div>
        <VerdictLine v={v} />
        <Fields r={receipt} />
      </div>
      <div className="panel">
        <label className="total-label" htmlFor={id}>Verify another receipt</label>
        <p className="faint receipt-help">Paste a receipt as JSON, or the value of a <code className="inline">PENSTOCK-RECEIPT</code> response header. It is checked here in your browser; nothing is sent anywhere.</p>
        <textarea id={id} className="receipt-input mono" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"body":{...},"sig":"...","pub":"..."}' spellCheck={false} />
        <div className="receipt-actions">
          <button type="button" className="btn btn-primary" onClick={() => void check()} disabled={!text.trim()}>Verify</button>
          <button type="button" className="btn btn-ghost" onClick={() => setText(JSON.stringify(receipt, null, 2))}>Paste the real one</button>
        </div>
        {pasted && <VerdictLine v={pasted.v} />}
        {pasted?.r && pasted.v?.valid && <Fields r={pasted.r} />}
      </div>
    </div>
  );
}
