/**
 * Per-controller outbound rate limit (token bucket). Process-local on purpose: it protects the
 * vendor controller (and ECLOUD) from a burst of portal logins or a runaway job in ONE process.
 * Each API / worker replica has its own buckets, so the fleet-wide ceiling is
 * `replicas × capacity`; the documented defaults keep that well below any vendor limit we know
 * of (vendor limits are REQUIRES_CLARIFICATION, docs/VENDOR_INTEGRATION_RESEARCH.md §6).
 */

export interface RateLimiter {
  /** Takes one token for `key`; false when the bucket is empty (the request must not be sent). */
  take(key: string): boolean;
}

export interface TokenBucketOptions {
  /** Burst size per key. Default 20. */
  readonly capacity?: number;
  /** Sustained requests per second per key. Default 5. */
  readonly refillPerSecond?: number;
  /** Upper bound of tracked keys (oldest dropped first). Default 10 000. */
  readonly maxKeys?: number;
  readonly now?: () => number;
}

export const DEFAULT_RATE_LIMIT = Object.freeze({ capacity: 20, refillPerSecond: 5 });

export class TokenBucketLimiter implements RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_RATE_LIMIT.capacity;
    this.refillPerMs = (options.refillPerSecond ?? DEFAULT_RATE_LIMIT.refillPerSecond) / 1000;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
    if (!(this.capacity >= 1) || !(this.refillPerMs > 0)) {
      throw new RangeError('rate limit capacity must be >= 1 and refill > 0');
    }
  }

  take(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next();
        if (oldest.done !== true) this.buckets.delete(oldest.value);
      }
      bucket = { tokens: this.capacity, at: now };
    } else {
      this.buckets.delete(key); // re-insert below: Map order = least recently used first
      bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.refillPerMs);
      bucket.at = now;
    }
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
