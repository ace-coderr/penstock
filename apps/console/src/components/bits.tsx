import { useEffect, useRef, type ReactNode } from "react";
import type { ApiError } from "../api";
import { CHAIN_META } from "../format";

export function Section({ idx, title, aside, children }: { idx: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="sec" aria-labelledby={`sec-${idx}`}>
      <div className="sec-h">
        <span className="idx">{idx}</span>
        <h2 id={`sec-${idx}`}>{title}</h2>
        {aside && <span className="aside">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export function PageHead({ eyebrow, title, children, aside }: { eyebrow: string; title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="page-h">
      <div>
        <span className="eyebrow"><i aria-hidden="true" />{eyebrow}</span>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {aside && <div className="aside">{aside}</div>}
    </div>
  );
}

export function Chain({ chain }: { chain: string }) {
  const m = CHAIN_META[chain] ?? { label: chain, tag: chain.slice(0, 3).toUpperCase() };
  return (
    <span className="chain" title={m.label}>
      <b aria-label={m.label}>{m.tag}</b>
    </span>
  );
}

export function Status({ value }: { value: string }) {
  return <span className={`st st-${value}`}>{value}</span>;
}

export function Sim({ on, children = "Simulated" }: { on: boolean; children?: ReactNode }) {
  return on ? <span className="sim-inline">{children}</span> : null;
}

export function Loading({ lines = 4 }: { lines?: number }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const unreachable = error.status === 0;
  const unauthorized = error.status === 401;
  return (
    <div className="state state-error" role="alert">
      <span className="state-title">{unreachable ? "Proxy not reachable" : unauthorized ? "Admin token needed" : "Could not load"}</span>
      {unreachable ? (
        <p>The console reads from the Penstock proxy on port 4020. Start everything with <code>pnpm demo</code>, then retry.</p>
      ) : unauthorized ? (
        <p>This proxy has <code>ADMIN_TOKEN</code> set. Enter it in the token field at the top right.</p>
      ) : (
        <p>{error.message}</p>
      )}
      <button className="btn" onClick={onRetry}>Retry</button>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="state">
      <span className="state-title">{title}</span>
      <p>{children}</p>
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabIndex={-1} ref={ref}>
        <div className="drawer-h">
          <h2 id="drawer-title">{title}</h2>
          <span className="spacer" />
          <button className="btn" onClick={onClose} aria-label="Close receipt">Close</button>
        </div>
        <div className="drawer-b">{children}</div>
      </div>
    </>
  );
}
