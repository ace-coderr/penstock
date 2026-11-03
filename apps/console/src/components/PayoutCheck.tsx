import { useState, type FormEvent } from "react";
import { ChainUnreachable, isNearAccountId, readAccount, type AccountState } from "../chain";
import { money, moneyExact, when } from "../format";
import { RealBadge } from "./OnChain";

type Result = { state: "idle" } | { state: "checking"; account: string } | { state: "done"; value: AccountState } | { state: "error"; account: string; message: string };

/**
 * Payout-account check for any NEAR account, read live from mainnet in the browser: does it exist,
 * is USDC storage registered, what does it hold. No keys, no wallet connection.
 */
export function PayoutCheck({ initial = "acedevv.near" }: { initial?: string }) {
  const [res, setRes] = useState<Result>({ state: "idle" });
  async function check(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const account = String(new FormData(e.currentTarget).get("account") ?? "").trim().toLowerCase();
    if (!isNearAccountId(account)) {
      setRes({ state: "error", account, message: "That is not a valid NEAR account id (lowercase letters, digits, - and _, separated by dots; or a 64-character implicit account)." });
      return;
    }
    setRes({ state: "checking", account });
    try {
      setRes({ state: "done", value: await readAccount(account) });
    } catch (err) {
      setRes({ state: "error", account, message: err instanceof ChainUnreachable ? "Could not reach the chain: neither NEAR RPC answered. Try again in a moment." : (err as Error).message });
    }
  }
  const v = res.state === "done" ? res.value : null;
  return (
    <form onSubmit={check} className="payout-check">
      <p className="lede">Check any NEAR account before you use it as a payout account. 1Click rejects quotes to accounts that do not exist, so Penstock checks first.</p>
      <p className="no-keys"><strong>Penstock never asks for your keys or a wallet connection.</strong> Payments go straight to your account.</p>
      <div className="toolbar">
        <div className="field" style={{ flex: "1 1 260px" }}>
          <label htmlFor="payout-acc">NEAR account</label>
          <input id="payout-acc" name="account" defaultValue={initial} autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="text" />
        </div>
        <button className="btn" disabled={res.state === "checking"}>{res.state === "checking" ? "Checking mainnet…" : "Check on mainnet"}</button>
      </div>
      <div role="status" aria-live="polite">
        {res.state === "error" && <div className="account-result is-bad"><span className="account-name mono">{res.account || "—"}</span><p>{res.message}</p></div>}
        {v && (
          <div className={`account-result ${v.exists ? "is-ok" : "is-bad"}`}>
            <div className="account-row">
              <span className="account-name mono">{v.account}</span>
              <RealBadge />
            </div>
            {!v.exists ? (
              <p><span className="no">✗ Not found on mainnet.</span> Create the account first: 1Click would refuse to quote payments to it.</p>
            ) : (
              <ul className="onchain-facts">
                <li><span className="yes">✓ Account exists</span></li>
                <li>
                  {v.storageRegistered
                    ? <span className="yes">✓ USDC storage registered</span>
                    : <><span className="no">Not registered yet:</span> the first payment registers it for about 0.005 USDC, paid by the payer.</>}
                </li>
                <li>USDC balance <span className="mono" title={moneyExact(v.usdcBalance)}>{money(v.usdcBalance)}</span></li>
              </ul>
            )}
            <p className="faint onchain-src">Read live from <span className="mono">{new URL(v.rpc).host}</span> · {when(Date.parse(v.at))}</p>
          </div>
        )}
      </div>
    </form>
  );
}
