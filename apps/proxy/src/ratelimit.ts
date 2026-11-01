/** Token-bucket rate limiter keyed by buyer handle and action. In-memory and bounded in size. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly limits: Record<string, { perMinute: number; burst: number }>, private readonly maxKeys = 50_000) {}

  /** Returns 0 if allowed, otherwise the seconds to wait. */
  take(action: string, key: string, now = Date.now()): number {
    const limit = this.limits[action];
    if (!limit) return 0;
    const id = `${action}|${key}`;
    const refill = limit.perMinute / 60_000;
    const b = this.buckets.get(id) ?? { tokens: limit.burst, at: now };
    b.tokens = Math.min(limit.burst, b.tokens + (now - b.at) * refill);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(id, b);
      return Math.ceil((1 - b.tokens) / refill / 1000);
    }
    b.tokens -= 1;
    if (this.buckets.size >= this.maxKeys && !this.buckets.has(id)) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    this.buckets.set(id, b);
    return 0;
  }
}

export const DEFAULT_LIMITS = {
  request: { perMinute: 240, burst: 60 },
  quote: { perMinute: 12, burst: 6 },
  routes: { perMinute: 30, burst: 10 },
  session: { perMinute: 600, burst: 120 },
  admin: { perMinute: 600, burst: 200 },
};
