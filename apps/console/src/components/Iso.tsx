import { createContext, useContext, type ReactNode } from "react";
import { useMotionAllowed } from "../motion";

/** Whether continuous pulses should render (false under prefers-reduced-motion). */
const PulseCtx = createContext(true);

/**
 * Isometric illustrations, drawn in code. World coordinates (x right-back, y left-back, z up)
 * are projected with the standard 30° isometric transform. Colours come from CSS classes that
 * read the design tokens; the only accent is on flow lines, the gate and the NEAR USDC slab.
 */

const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;

type P = [number, number];

function iso(x: number, y: number, z = 0): P {
  return [(x - y) * COS, (x + y) * SIN - z];
}

const pts = (ps: P[]) => ps.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");

interface SlabProps {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  tone?: "plain" | "accent" | "dim" | "ghost";
  /** Entrance order; slabs with an index rise in on load. */
  anim?: number;
  children?: ReactNode;
}

/** A box: top face plus the two visible side faces. */
function Slab({ x, y, w, d, h, tone = "plain", anim, children }: SlabProps) {
  const top = [iso(x, y, h), iso(x + w, y, h), iso(x + w, y + d, h), iso(x, y + d, h)];
  const left = [iso(x, y + d, h), iso(x + w, y + d, h), iso(x + w, y + d, 0), iso(x, y + d, 0)];
  const right = [iso(x + w, y, h), iso(x + w, y + d, h), iso(x + w, y + d, 0), iso(x + w, y, 0)];
  return (
    <g className={`iso-slab iso-${tone}${anim !== undefined ? " iso-slab-anim" : ""}`} style={anim !== undefined ? ({ "--i": anim } as React.CSSProperties) : undefined}>
      <polygon className="iso-left" points={pts(left)} />
      <polygon className="iso-right" points={pts(right)} />
      <polygon className="iso-top" points={pts(top)} />
      {children}
    </g>
  );
}

/** Text lying flat on a top face, running along the x axis. */
function TopText({ x, y, z, size = 9, className = "iso-label", children }: { x: number; y: number; z: number; size?: number; className?: string; children: ReactNode }) {
  const [tx, ty] = iso(x, y, z);
  return (
    <text className={className} fontSize={size} transform={`matrix(${COS} ${SIN} ${-COS} ${SIN} ${tx.toFixed(1)} ${ty.toFixed(1)})`}>
      {children}
    </text>
  );
}

/** A flow path through world points (on the ground plane), smoothed in screen space. */
function flowPath(points: [number, number, number][]): string {
  const s = points.map(([x, y, z]) => iso(x, y, z));
  let d = `M ${s[0]![0].toFixed(1)} ${s[0]![1].toFixed(1)}`;
  for (let i = 1; i < s.length; i++) {
    const [px, py] = s[i - 1]!;
    const [cx, cy] = s[i]!;
    const mx = (px + cx) / 2;
    d += ` C ${mx.toFixed(1)} ${py.toFixed(1)}, ${mx.toFixed(1)} ${cy.toFixed(1)}, ${cx.toFixed(1)} ${cy.toFixed(1)}`;
  }
  return d;
}

/** A flow line plus a marker that travels along it (animateMotion moves it by transform). */
function Flow({ d, i = 0, strong = false, delay = 0 }: { d: string; i?: number; strong?: boolean; delay?: number }) {
  const pulses = useContext(PulseCtx);
  return (
    <g>
      <path d={d} className={strong ? "iso-flow iso-flow-strong" : "iso-flow"} />
      {pulses && (
        <circle r={strong ? 2.6 : 1.9} className="iso-pulse-dot">
          <animateMotion dur="3.2s" repeatCount="indefinite" begin={`${(delay + i * 0.45).toFixed(2)}s`} path={d} />
        </circle>
      )}
    </g>
  );
}

function Scene({ box, label, desc, children, className }: { box: [number, number, number, number]; label: string; desc?: string; children: ReactNode; className?: string }) {
  const id = label.replace(/[^a-z]/gi, "").slice(0, 16);
  const pulses = useMotionAllowed();
  return (
    <PulseCtx.Provider value={pulses}>
    <svg viewBox={box.join(" ")} role={desc ? "img" : undefined} aria-labelledby={desc ? `${id}-t ${id}-d` : undefined} aria-hidden={desc ? undefined : true} className={className}>
      {desc && <title id={`${id}-t`}>{label}</title>}
      {desc && <desc id={`${id}-d`}>{desc}</desc>}
      {children}
    </svg>
    </PulseCtx.Provider>
  );
}

const SOURCES = ["Base", "Arbitrum", "Solana", "Ethereum", "Bitcoin", "Optimism"];

export function HeroArt() {
  const W = 66, D = 30, H = 9, GAP = 44;
  const gate = { x: 170, y: 112, w: 16, d: 52, h: 62 };
  const sink = { x: 250, y: 92, w: 112, d: 92, h: 20 };
  const midY = gate.y + gate.d / 2;
  return (
    <Scene
      box={[-240, -26, 494, 318]}
      className="iso-hero"
      label="Payments from many chains flowing into one NEAR USDC account"
      desc={`Six source chains (${SOURCES.join(", ")}) send payments along flow lines through a single Penstock gate into one slab labelled USDC on NEAR.`}
    >
      <g className="iso-grid">
        {Array.from({ length: 9 }, (_, i) => <path key={`a${i}`} d={`M ${iso(-20, i * 40).join(" ")} L ${iso(400, i * 40).join(" ")}`} />)}
        {Array.from({ length: 11 }, (_, i) => <path key={`b${i}`} d={`M ${iso(i * 40, -20).join(" ")} L ${iso(i * 40, 320).join(" ")}`} />)}
      </g>

      <defs>
        <mask id="hero-flow-mask" maskUnits="userSpaceOnUse" x={-240} y={-26} width={494} height={318}>
          <rect className="iso-reveal" x={-240} y={-26} width={494} height={318} fill="white" />
        </mask>
      </defs>
      {/* Flow lines are revealed left to right after the slabs land, then pulses travel along them. */}
      <g mask="url(#hero-flow-mask)">
        {SOURCES.map((name, i) => {
          const y = i * GAP;
          return (
            <Flow key={`f${name}`} i={i} delay={1.2} d={flowPath([[W, y + D / 2, 2], [gate.x - 18, midY + (i - 2.5) * 5, 2], [gate.x, midY, 2]])} />
          );
        })}
        <Flow strong i={2} delay={1.4} d={flowPath([[gate.x + gate.w, midY, 2], [sink.x, midY, 2]])} />
      </g>

      {SOURCES.map((name, i) => {
        const y = i * GAP;
        return (
          <Slab key={name} x={0} y={y} w={W} d={D} h={H} tone={i === 4 ? "dim" : "plain"} anim={i}>
            <TopText x={8} y={y + 19} z={H} size={10}>{name}</TopText>
          </Slab>
        );
      })}

      {/* The gate: two posts and a lintel, the accent channel running through it. */}
      <Slab x={gate.x} y={gate.y} w={gate.w} d={8} h={gate.h} anim={6} />
      <Slab x={gate.x} y={gate.y + gate.d - 8} w={gate.w} d={8} h={gate.h} anim={6} />
      <Slab x={gate.x} y={gate.y} w={gate.w} d={gate.d} h={8} tone="accent" anim={6} />
      <Slab x={gate.x - 2} y={gate.y - 2} w={gate.w + 4} d={gate.d + 4} h={4} tone="dim" anim={6} />
      <TopText x={gate.x + 2} y={gate.y + 30} z={gate.h + 3} size={8} className="iso-label iso-label-muted">x402</TopText>
      <Slab x={gate.x} y={gate.y} w={gate.w} d={gate.d} h={gate.h} tone="ghost" />

      <Slab {...sink} tone="accent" anim={7}>
        <TopText x={sink.x + 12} y={sink.y + 30} z={sink.h} size={15} className="iso-label iso-label-accent">USDC · NEAR</TopText>
        <TopText x={sink.x + 12} y={sink.y + 50} z={sink.h} size={9} className="iso-label iso-label-muted">one account</TopText>
      </Slab>
    </Scene>
  );
}

export function CardArt({ kind }: { kind: "protect" | "chains" | "sessions" | "books" }) {
  if (kind === "protect") {
    return (
      <Scene box={[-104, -10, 214, 123]} label="Endpoint behind a gate">
        <Flow strong d={flowPath([[-10, 46, 2], [40, 46, 2], [86, 46, 2]])} />
        <path d={flowPath([[-10, 70, 2], [34, 70, 2]])} className="iso-flow iso-flow-blocked" />
        <Slab x={34} y={30} w={10} d={52} h={34} tone="plain" />
        <Slab x={34} y={30} w={10} d={52} h={5} tone="accent" />
        <Slab x={86} y={24} w={56} d={44} h={14} tone="plain">
          <TopText x={92} y={50} z={14} size={9}>/p/tides</TopText>
        </Slab>
        <g className="iso-chip"><rect x={-96} y={34} width={30} height={14} rx={3} /><text x={-81} y={44.5} textAnchor="middle">402</text></g>
      </Scene>
    );
  }
  if (kind === "chains") {
    return (
      <Scene box={[-82, -15, 217, 149]} label="Three chains converging into USDC">
        {[0, 1, 2].map((i) => <Flow key={i} i={i} d={flowPath([[36, i * 32 + 12, 2], [96, 52, 2], [120, 52, 2]])} />)}
        {["SOL", "BASE", "BTC"].map((n, i) => (
          <Slab key={n} x={0} y={i * 32} w={36} d={22} h={7}><TopText x={5} y={i * 32 + 14} z={7} size={8}>{n}</TopText></Slab>
        ))}
        <Slab x={120} y={30} w={56} d={46} h={14} tone="accent"><TopText x={126} y={56} z={14} size={10} className="iso-label iso-label-accent">USDC</TopText></Slab>
      </Scene>
    );
  }
  if (kind === "sessions") {
    const cells = 6;
    return (
      <Scene box={[-56, -52, 157, 130]} label="A metered session balance">
        <Slab x={0} y={20} w={84} d={36} h={10} tone="dim" />
        {Array.from({ length: cells }, (_, i) => (
          <Slab key={i} x={4 + i * 13} y={24} w={10} d={28} h={10 + (i < 4 ? 12 : 4)} tone={i < 4 ? "accent" : "plain"} />
        ))}
        <g className="iso-chip"><rect x={34} y={-44} width={58} height={14} rx={3} /><text x={63} y={-33.5} textAnchor="middle">cap $5</text></g>
      </Scene>
    );
  }
  return (
    <Scene box={[-72, -22, 156, 115]} label="A ledger that closes">
      <Slab x={0} y={10} w={96} d={64} h={8}>
        {[0, 1, 2, 3].map((i) => (
          <path key={i} className={i === 3 ? "iso-row iso-row-accent" : "iso-row"} d={`M ${iso(10, 20 + i * 12, 8).join(" ")} L ${iso(i === 3 ? 60 : 84, 20 + i * 12, 8).join(" ")}`} />
        ))}
      </Slab>
      <g className="iso-chip iso-chip-accent"><rect x={30} y={-14} width={46} height={14} rx={3} /><text x={53} y={-3.5} textAnchor="middle">✓ CSV</text></g>
    </Scene>
  );
}
