/** Illustrations for the landing page (filled in by the illustration pass). */
export function HeroArt() {
  return <svg viewBox="0 0 560 420" role="img" aria-label="Payments from many chains flowing into one NEAR USDC account" />;
}

export function CardArt({ kind }: { kind: "protect" | "chains" | "sessions" | "books" }) {
  return <svg viewBox="0 0 220 120" data-kind={kind} />;
}
