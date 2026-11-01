import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { countValue, motionAllowed, REDUCED_QUERY } from "../src/motion";

const src = new URL("../src/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, src), "utf8");
const cssFiles = readdirSync(src).filter((f) => f.endsWith(".css"));
const allCss = cssFiles.map((f) => read(f)).join("\n");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));
}

describe("motion respects prefers-reduced-motion", () => {
  it("zeroes every motion duration, stagger and offset token", () => {
    const tokens = read("tokens.css");
    const declared = [...tokens.matchAll(/--(dur-[a-z]+|stagger|rise):/g)].map((m) => m[1]);
    const reduce = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(declared.length).toBeGreaterThan(6);
    for (const name of new Set(declared)) expect(reduce).toMatch(new RegExp(`--${name}: 0(ms|px);`));
  });

  it("stops every animation and transition globally", () => {
    const base = read("base.css");
    const block = base.slice(base.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/animation-duration: 0\.001ms !important/);
    expect(block).toMatch(/animation-iteration-count: 1 !important/);
    expect(block).toMatch(/transition: none !important/);
  });

  it("shows anything that would otherwise wait to be revealed", () => {
    const motion = read("motion.css");
    const block = motion.slice(motion.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/\.reveal \{ opacity: 1; transform: none;/);
  });

  it("only renders continuous SVG pulses behind the reduced-motion check", () => {
    const files = walk(fileURLToPath(new URL("../src", import.meta.url)));
    const withPulses = files.filter((f) => readFileSync(f, "utf8").includes("<animateMotion"));
    expect(withPulses.length).toBeGreaterThan(0);
    for (const f of withPulses) expect(readFileSync(f, "utf8")).toMatch(/useMotionAllowed\(\)/);
  });

  it("reports motion as not allowed when the user asks for reduced motion", () => {
    expect(motionAllowed((q) => ({ matches: q === REDUCED_QUERY }))).toBe(false);
    expect(motionAllowed(() => ({ matches: false }))).toBe(true);
    expect(motionAllowed(undefined)).toBe(true);
  });
});

describe("motion stays fast and compositor-friendly", () => {
  it("animates only transform and opacity in every keyframe", () => {
    const frames = [...allCss.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g)];
    expect(frames.length).toBeGreaterThan(8);
    for (const [, name, body] of frames) {
      const props = [...body!.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const p of props) expect(["transform", "opacity"], `@keyframes ${name} animates ${p}`).toContain(p);
    }
  });

  it("times one-shot animations with tokens and keeps them at or under 600ms", () => {
    const decls = [...allCss.matchAll(/animation:\s*([^;]+);/g)].map((m) => m[1]!);
    for (const d of decls) {
      if (/infinite/.test(d)) expect(d, d).toMatch(/var\(--loop-/);
      else expect(d, d).toMatch(/var\(--dur-/);
    }
    const tokens = read("tokens.css");
    for (const [, name, ms] of tokens.matchAll(/--(dur-[a-z]+): (\d+)ms;/g)) {
      if (Number(ms) > 0) expect(Number(ms), name).toBeLessThanOrEqual(600);
    }
  });

  it("eases count-ups from start to target", () => {
    expect(countValue(0, 100, 0)).toBe(0);
    expect(countValue(0, 100, 1)).toBe(100);
    expect(countValue(0, 100, 2)).toBe(100);
    expect(countValue(10, 20, 0.5)).toBeGreaterThan(15);
  });
});
