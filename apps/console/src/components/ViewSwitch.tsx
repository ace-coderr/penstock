import { useEffect, useState } from "react";
import { RealBadge } from "./OnChain";

/**
 * "Simulated | Real (on-chain)" for the Ledger and Payments tabs. The choice lives in the hash query
 * (/app#/payments?view=real), so a link can open the Real view and a reload keeps it.
 */
export type View = "simulated" | "real";

const readView = (): View => (new URLSearchParams(location.hash.split("?")[1] ?? "").get("view") === "real" ? "real" : "simulated");

export function useView(): [View, (v: View) => void] {
  const [v, setV] = useState<View>(readView);
  useEffect(() => {
    const on = () => setV(readView());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const set = (next: View) => {
    const path = location.hash.replace(/^#/, "").split("?")[0] || "/";
    location.hash = next === "real" ? `${path}?view=real` : path;
  };
  return [v, set];
}

export function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="view-switch">
      <div className="seg" role="group" aria-label="Data shown">
        <button type="button" aria-pressed={view === "simulated"} onClick={() => onChange("simulated")}>Simulated</button>
        <button type="button" aria-pressed={view === "real"} onClick={() => onChange("real")}>Real (on-chain)</button>
      </div>
      {view === "real" ? <RealBadge /> : <span className="sim">Simulated</span>}
    </div>
  );
}
