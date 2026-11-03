import { useProof } from "../proof";
import { Loading, PageHead, Section } from "./bits";
import { RealBadge, SellerOnChain } from "./OnChain";
import { RealTransactions } from "./RealTransactions";
import { ReceiptVerifier } from "./ReceiptVerifier";

/**
 * The Real (on-chain) view of the Ledger and Payments tabs: the seller's live mainnet account, the real
 * payment and refund from proof.json, and the payment's receipt verified in the browser. Nothing here
 * is simulated.
 */
export function RealView({ tab }: { tab: "ledger" | "payments" }) {
  const { proof, error } = useProof();
  const ledger = tab === "ledger";
  return (
    <>
      <PageHead eyebrow={ledger ? "01 · Ledger · Real" : "02 · Payments · Real"} title={ledger ? "What really came in, on mainnet" : "Real payments, on mainnet"} aside={<RealBadge />}>
        Read live from NEAR mainnet in your browser, plus the real transactions recorded in PROOF.md. No simulated data on this view.
      </PageHead>
      {error ? (
        <div className="state"><span className="state-title">Could not load the proof record</span><p>/proof.json did not load ({error.message}). The same transactions are listed in docs/PROOF.md on GitHub.</p></div>
      ) : !proof ? <Loading lines={6} /> : (
        <>
          <Section idx="01" title={ledger ? "Seller account, read live" : "Where the money landed, read live"}>
            <SellerOnChain proof={proof} />
          </Section>
          <Section idx="02" title="The real payment and the real refund">
            <RealTransactions proof={proof} />
          </Section>
          <Section idx="03" title="Receipt, verified in your browser">
            <ReceiptVerifier receipt={proof.entries.find((e) => e.receipt)!.receipt!} />
          </Section>
        </>
      )}
    </>
  );
}
