import type { ChainRow } from "../api";
import { money } from "../format";
import { useMotionAllowed } from "../motion";

/**
 * Inflow diagram: one line per origin chain, its weight proportional to USDC delivered,
 * all converging on the seller's single NEAR account. Pulses travel along each line
 * (disabled under prefers-reduced-motion).
 */
export function Flow({ rows, account, simulated }: { rows: ChainRow[]; account: string; simulated: boolean }) {
  const pulses = useMotionAllowed();
  const W = 720;
  const rowH = 34;
  const H = Math.max(220, rows.length * rowH + 40);
  const total = rows.reduce((a, r) => a + Number(r.receivedUsdc), 0) || 1;
  const sink = { x: 548, y: H / 2 };
  const startX = 210;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="flow-title flow-desc">
      <title id="flow-title">Where the money came from</title>
      <desc id="flow-desc">
        {rows.map((r) => `${r.label}: ${money(r.receivedUsdc)} from ${r.count} payments`).join("; ")}. All delivered as USDC to {account}.
      </desc>
      {rows.map((r, i) => {
        const y = 24 + i * rowH + rowH / 2;
        const share = Number(r.receivedUsdc) / total;
        const w = Math.max(1.5, Math.min(16, share * 60));
        const d = `M ${startX} ${y} C ${startX + 170} ${y}, ${sink.x - 170} ${sink.y}, ${sink.x} ${sink.y}`;
        return (
          <g key={r.chain}>
            <rect x={8} y={y - 11} width={2} height={22} className="flow-tick" />
            <text x={20} y={y - 1} className="flow-tag">{r.label}{r.label !== r.label.toUpperCase() && <tspan className="flow-code" dx={6}>{r.tag}</tspan>}</text>
            <text x={20} y={y + 12} className="flow-label">{r.count} pay{r.refunded ? ` · ${r.refunded} ref` : ""}</text>
            <text x={startX - 10} y={y + 4} className="flow-amt" textAnchor="end">{money(r.receivedUsdc)}</text>
            <path d={d} className="flow-line" strokeWidth={w} strokeOpacity={0.25 + Math.min(0.6, share * 1.5)} />
            {pulses && (
              <circle r={Math.max(1.6, Math.min(3, w / 4))} className="flow-pulse-dot">
                <animateMotion dur="3.2s" repeatCount="indefinite" begin={`${((i * 0.37) % 2.8).toFixed(2)}s`} path={d} />
              </circle>
            )}
          </g>
        );
      })}
      <g>
        <rect x={sink.x} y={sink.y - 34} width={W - sink.x - 8} height={68} rx={6} className="flow-sink" strokeWidth={1.2} />
        <text x={sink.x + 12} y={sink.y - 12} className="flow-sink-tag">USDC · NEAR</text>
        <text x={sink.x + 12} y={sink.y + 6} className="flow-amt">{account.length > 22 ? account.slice(0, 21) + "…" : account}</text>
        <text x={sink.x + 12} y={sink.y + 22} className="flow-label">{simulated ? "simulated settlement" : "settled on mainnet"}</text>
      </g>
    </svg>
  );
}

export function Bars({ daily }: { daily: { day: string; receivedUsdc: string; count: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => Number(d.receivedUsdc)));
  return (
    <div>
      <div className="bars" role="list" aria-label="USDC received per day">
        {daily.map((d) => (
          <div
            key={d.day}
            style={{ "--i": daily.indexOf(d), height: `${(Number(d.receivedUsdc) / max) * 100}%` } as React.CSSProperties}
            role="listitem"
            tabIndex={0}
            className="bar"
            title={`${d.day}: ${money(d.receivedUsdc)} from ${d.count} payments`}
            aria-label={`${d.day}: ${money(d.receivedUsdc)} from ${d.count} payments`}
          />
        ))}
      </div>
      <div className="bars-axis" aria-hidden="true">
        <span>{daily[0]?.day}</span>
        <span>{daily[daily.length - 1]?.day}</span>
      </div>
    </div>
  );
}
