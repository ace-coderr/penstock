/**
 * Penstock wordmark: a sluice-gate mark (three intakes meeting one channel through a gate)
 * set beside the name in the display serif. Original artwork, drawn in code.
 */
export function Wordmark({ size = 22, label = true }: { size?: number; label?: boolean }) {
  const h = size;
  return (
    <svg height={h} viewBox={`0 0 ${label ? 132 : 28} 28`} role="img" aria-label="Penstock" style={{ overflow: "visible" }}>
      <g fill="none" strokeLinecap="round">
        <path d="M2 6 C9 6 9 14 15 14 M2 14 H15 M2 22 C9 22 9 14 15 14" stroke="var(--accent)" strokeWidth="1.8" />
        <rect x="15" y="7.5" width="5" height="13" rx="1" stroke="var(--text)" strokeWidth="1.6" />
        <path d="M20 14 H27" stroke="var(--text)" strokeWidth="1.8" />
      </g>
      {label && (
        <text x="35" y="20.5" style={{ font: "500 21px var(--font-serif)", letterSpacing: "-0.01em" }} fill="var(--text)">
          Penstock
        </text>
      )}
    </svg>
  );
}
