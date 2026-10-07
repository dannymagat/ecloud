/**
 * Small key-value surface the API needs from Redis: counters (rate limits, lockout), short-lived
 * tokens (MFA challenges), idempotency records and the AAA retransmit cache. `RedisKv` is the
 * production implementation; `MemoryKv` is the in-process fallback used by tests and
 * single-process development (`KV_DRIVER=memory`, refused in production).
 */
import { Redis } from 'ioredis';

export interface KvStore {
  get(key: string): Promise<string | null>;
  /** Sets `key` with a TTL. With `onlyIfAbsent`, returns false when the key already exists. */
  set(key: string, value: string, ttlSeconds: number, onlyIfAbsent?: boolean): Promise<boolean>;
  /** Increments a counter; the TTL is applied when the counter is created. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Remaining TTL in seconds (0 when the key does not exist or has no TTL). */
  ttl(key: string): Promise<number>;
  del(key: string): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class MemoryKv implements KvStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  set(key: string, value: string, ttlSeconds: number, onlyIfAbsent = false): Promise<boolean> {
    if (onlyIfAbsent && this.live(key) !== undefined) return Promise.resolve(false);
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    return Promise.resolve(true);
  }

  incr(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.live(key);
    if (entry === undefined) {
      this.entries.set(key, { value: '1', expiresAt: this.now() + ttlSeconds * 1000 });
      return Promise.resolve(1);
    }
    const next = Number(entry.value) + 1;
    entry.value = String(next);
    return Promise.resolve(next);
  }

  ttl(key: string): Promise<number> {
    const entry = this.live(key);
    return Promise.resolve(
      entry === undefined ? 0 : Math.max(0, Math.ceil((entry.expiresAt - this.now()) / 1000)),
    );
  }

  del(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }
}

export class RedisKv implements KvStore {
  constructor(private readonly redis: Redis) {}

  static connect(url: string): RedisKv {
    const redis = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
    });
    // Connection errors surface through command rejections (readyz, fail-closed auth paths);
    // without a listener ioredis would print them as unhandled 'error' events.
    redis.on('error', () => undefined);
    return new RedisKv(redis);
  }

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(
    key: string,
    value: string,
    ttlSeconds: number,
    onlyIfAbsent = false,
  ): Promise<boolean> {
    const result = onlyIfAbsent
      ? await this.redis.set(key, value, 'EX', ttlSeconds, 'NX')
      : await this.redis.set(key, value, 'EX', ttlSeconds);
    return result === 'OK';
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const results = await this.redis.multi().incr(key).expire(key, ttlSeconds, 'NX').exec();
    const value = results?.[0]?.[1];
    if (typeof value !== 'number') throw new Error('redis INCR failed');
    return value;
  }

  async ttl(key: string): Promise<number> {
    const value = await this.redis.ttl(key);
    return value > 0 ? value : 0;
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
