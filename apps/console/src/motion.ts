import { useEffect, useRef, useState } from "react";

/**
 * Motion helpers. CSS handles most animation; these cover what CSS cannot: counting numbers,
 * revealing on scroll, and deciding whether to render continuous SVG pulses at all.
 * Every helper respects prefers-reduced-motion.
 */

export const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
export const COUNT_MS = 600;

type MatchMedia = (q: string) => { matches: boolean };

/** True when the environment allows motion (pure, so it can be tested without a DOM). */
export function motionAllowed(matchMedia: MatchMedia | undefined): boolean {
  if (!matchMedia) return true;
  try {
    return !matchMedia(REDUCED_QUERY).matches;
  } catch {
    return true;
  }
}

export function useMotionAllowed(): boolean {
  const mm = typeof window !== "undefined" && window.matchMedia ? window.matchMedia.bind(window) : undefined;
  const [ok, setOk] = useState(() => motionAllowed(mm));
  useEffect(() => {
    if (!mm) return;
    const q = window.matchMedia(REDUCED_QUERY);
    const on = () => setOk(!q.matches);
    q.addEventListener?.("change", on);
    return () => q.removeEventListener?.("change", on);
  }, []);
  return ok;
}

/** Ease-out-cubic interpolation used by count-ups. */
export function countValue(from: number, to: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return from + (to - from) * (1 - Math.pow(1 - k, 3));
}

/** Animates a number from its previous value to `target` (or from 0 when `fromZero`). */
export function useCountUp(target: number, opts: { start?: boolean; fromZero?: boolean } = {}): number {
  const allowed = useMotionAllowed();
  const start = opts.start ?? true;
  const [shown, setShown] = useState(opts.fromZero ? 0 : target);
  const prev = useRef(opts.fromZero ? 0 : target);
  useEffect(() => {
    if (!start) return;
    if (!allowed || prev.current === target) {
      prev.current = target;
      setShown(target);
      return;
    }
    const from = prev.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = (now - t0) / COUNT_MS;
      setShown(countValue(from, target, t));
      if (t < 1) raf = requestAnimationFrame(tick);
      else prev.current = target;
    };
    raf = requestAnimationFrame(tick);
    // If frames are throttled (background tab), still land on the exact value.
    const done = setTimeout(() => {
      cancelAnimationFrame(raf);
      prev.current = target;
      setShown(target);
    }, COUNT_MS + 120);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
      prev.current = target;
    };
  }, [target, start, allowed]);
  return shown;
}

/** Adds `is-in` to the element once it scrolls into view. Without IntersectionObserver it shows at once. */
export function useReveal<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    // Automated browsers (screenshots, crawlers) get everything at once: content must never stay hidden.
    if (typeof IntersectionObserver === "undefined" || (typeof navigator !== "undefined" && navigator.webdriver)) {
      setSeen(true);
      return;
    }
    let delivered = false;
    const io = new IntersectionObserver((entries) => {
      delivered = true;
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    io.observe(el);
    // A browser always reports once right after observe(); if it never does, it is not rendering
    // (hidden or throttled), so reveal rather than leave the section invisible.
    const fallback = setTimeout(() => {
      if (!delivered) setSeen(true);
    }, 1500);
    return () => {
      io.disconnect();
      clearTimeout(fallback);
    };
  }, [seen]);
  return [ref, seen];
}

/** Returns the ids that appeared since the previous call (empty on the first call). */
export function useNewIds(ids: string[] | undefined): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef<Set<string>>(new Set());
  if (ids) {
    if (!seen.current) {
      seen.current = new Set(ids);
      fresh.current = new Set();
    } else {
      const next = ids.filter((id) => !seen.current!.has(id));
      if (next.length) {
        fresh.current = new Set(next);
        for (const id of next) seen.current.add(id);
      }
    }
  }
  return fresh.current;
}
