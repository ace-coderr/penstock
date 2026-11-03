import { useProof } from "../proof";
import { Loading, PageHead, Section } from "./bits";
import { RealBadge, SellerOnChain } from "./OnChain";

/**
 * The Real (on-chain) view of the Ledger and Payments tabs: the seller's live mainnet account and the
 * real transactions from proof.json. Nothing here is simulated.
 */
export function RealView({ tab }: { tab: "ledger" | "payments" }) {
  const { proof, error } = useProof();
  return (
    <>
      <PageHead eyebrow={tab === "ledger" ? "01 · Ledger · Real" : "02 · Payments · Real"} title={tab === "ledger" ? "What really came in, on mainnet" : "Real payments, on mainnet"} aside={<RealBadge />}>
        Read live from NEAR mainnet in your browser, plus the real transactions recorded in PROOF.md. No simulated data on this view.
      </PageHead>
      {error ? <div className="state"><span className="state-title">Could not load the proof record</span><p>/proof.json did not load ({error.message}). The same transactions are listed in docs/PROOF.md on GitHub.</p></div> : !proof ? <Loading lines={6} /> : (
        <Section idx="01" title="Seller account, read live">
          <SellerOnChain proof={proof} />
        </Section>
      )}
    </>
  );
}
