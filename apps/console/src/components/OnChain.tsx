import { useCallback, useEffect, useState } from "react";
import { ChainUnreachable, NEAR_USDC, readAccount, type AccountState } from "../chain";
import { money, moneyExact, short, when } from "../format";
import type { Proof } from "../proof";

/** Solid teal badge for anything read from mainnet. The amber "Simulated" badge is its opposite. */
export function RealBadge({ children = "Real · on-chain" }: { children?: string }) {
  return <span className="real">{children}</span>;
}

type Read = { state: "loading" } | { state: "live"; value: AccountState } | { state: "unreachable"; reason: string };

/** Live reads of one account; `reload` retries. */
export function useAccountRead(account: string | null): { read: Read; reload: () => void } {
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!account) return;
    let live = true;
    setRead({ state: "loading" });
    readAccount(account).then(
      (value) => live && setRead({ state: "live", value }),
      (e: Error) => live && setRead({ state: "unreachable", reason: e instanceof ChainUnreachable ? e.message : String(e.message) }),
    );
    return () => {
      live = false;
    };
  }, [account, n]);
  return { read, reload: useCallback(() => setN((x) => x + 1), []) };
}

function Yes({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={ok ? "yes" : "no"}><span aria-hidden="true">{ok ? "✓" : "✗"}</span> {children}</span>;
}

/**
 * The seller's account as mainnet sees it right now: exists, USDC balance, USDC storage. If neither
 * RPC answers, the last known values (snapshot in proof.json) are shown, labelled cached.
 */
export function SellerOnChain({ proof }: { proof: Proof }) {
  const account = proof.seller.account;
  const { read, reload } = useAccountRead(account);
  const cached = read.state === "unreachable";
  const v = read.state === "live" ? read.value : cached ? { ...proof.seller, rpc: proof.seller.source, at: proof.seller.snapshotAt } : null;
  return (
    <div className="panel onchain" aria-busy={read.state === "loading"}>
      <div className="onchain-head">
        <div>
          <div className="total-label">Seller account on NEAR mainnet</div>
          <a className="onchain-acct mono" href={`https://nearblocks.io/address/${account}`}>{account}</a>
        </div>
        {cached ? <span className="sim">Cached</span> : <RealBadge />}
      </div>
      {cached && (
        <div className="banner banner-bad" role="alert">
          <strong>Could not reach the chain.</strong> Neither NEAR RPC answered ({read.reason}). Showing the last known values from {when(Date.parse(proof.seller.snapshotAt))}, labelled cached.
          <button type="button" className="btn btn-ghost" onClick={reload}>Try again</button>
        </div>
      )}
      {!v ? (
        <div className="onchain-grid"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
      ) : (
        <>
          <div className="total num" title={moneyExact(v.usdcBalance)}>{money(v.usdcBalance)}<small>USDC {cached ? "(cached)" : ""}</small></div>
          <ul className="onchain-facts">
            <li><Yes ok={v.exists}>Account {v.exists ? "exists" : "not found"}</Yes></li>
            <li><Yes ok={v.storageRegistered}>USDC storage {v.storageRegistered ? "registered" : "not registered"}</Yes></li>
            <li className="faint">USDC balance via <code className="inline">ft_balance_of</code> on <span className="mono" title={NEAR_USDC}>{short(NEAR_USDC, 6)}</span></li>
          </ul>
          <p className="onchain-src faint">
            {cached ? "Snapshot" : "Read live"} from <span className="mono">{new URL(v.rpc).host}</span> · {when(Date.parse(v.at))}. Public chain data, no keys, no wallet.
          </p>
        </>
      )}
    </div>
  );
}
