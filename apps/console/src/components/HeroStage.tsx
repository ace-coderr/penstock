import { useEffect, useRef, type CSSProperties } from "react";
import { HeroArt } from "./Iso";
import { useMotionAllowed } from "../motion";

/**
 * The hero illustration with depth: translucent panels stacked behind the isometric scene, a soft
 * accent glow behind the gate, and chips that drift. Moving the pointer over it shifts each layer
 * by its depth (transform only). Under prefers-reduced-motion nothing drifts and the pointer is
 * not tracked.
 */
const CHIPS: { label: string; x: string; y: string; depth: number; accent?: boolean }[] = [
  { label: "HTTP 402", x: "6%", y: "9%", depth: 0.9 },
  { label: "$0.004", x: "52%", y: "5%", depth: 1.2, accent: true },
  { label: "refund", x: "10%", y: "80%", depth: 0.7 },
  { label: "receipt ✓", x: "78%", y: "32%", depth: 1.1, accent: true },
];

export function HeroStage() {
  const ref = useRef<HTMLDivElement>(null);
  const motion = useMotionAllowed();

  useEffect(() => {
    const el = ref.current;
    if (!el || !motion) return;
    let frame = 0;
    let tx = 0;
    let ty = 0;
    const apply = () => {
      frame = 0;
      el.style.setProperty("--px", tx.toFixed(3));
      el.style.setProperty("--py", ty.toFixed(3));
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = el.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const leave = () => {
      tx = 0;
      ty = 0;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      if (frame) cancelAnimationFrame(frame);
      el.style.removeProperty("--px");
      el.style.removeProperty("--py");
    };
  }, [motion]);

  const depth = (d: number) => ({ "--d": d } as CSSProperties);
  return (
    <div className="hs" ref={ref}>
      <div className="hs-layer hs-panel hs-panel-back" style={depth(-0.35)} aria-hidden="true" />
      <div className="hs-layer hs-panel hs-panel-mid" style={depth(-0.2)} aria-hidden="true" />
      <div className="hs-layer hs-glow" style={depth(0.15)} aria-hidden="true" />
      <div className="hs-layer hs-art" style={depth(0.3)}>
        <HeroArt />
      </div>
      {CHIPS.map((c, i) => (
        <span
          key={c.label}
          className={`hs-layer hs-chip mono${c.accent ? " hs-chip-accent" : ""}`}
          style={{ ...depth(c.depth), left: c.x, top: c.y, "--i": i } as CSSProperties}
          aria-hidden="true"
        >
          <span className="hs-chip-in">{c.label}</span>
        </span>
      ))}
    </div>
  );
}
