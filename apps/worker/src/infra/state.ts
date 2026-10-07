/**
 * Small Redis-backed state used by the worker: single-flight locks, the radacct drain cursor,
 * once-per-period markers and the "enforcement pending" set. Each has an in-memory twin with
 * the same interface for unit tests.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export const KEY_PREFIX = 'ecloud:worker:';

export interface WorkerState {
  /** Runs `fn` only if the lock is free; returns `undefined` when another holder has it. */
  withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined>;
  getCursor(name: string): Promise<number>;
  setCursor(name: string, value: number): Promise<void>;
  /** True the first time `key` is marked (within `ttlS`); false afterwards. */
  markOnce(key: string, ttlS: number): Promise<boolean>;
  setPending(sessionId: string, value: Record<string, unknown>): Promise<void>;
  clearPending(sessionId: string): Promise<void>;
  listPending(): Promise<Record<string, Record<string, unknown>>>;
}

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

const PENDING_KEY = `${KEY_PREFIX}enforcement:pending`;

export class RedisWorkerState implements WorkerState {
  constructor(private readonly redis: Redis) {}

  async withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
    const key = `${KEY_PREFIX}lock:${name}`;
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') return undefined;
    try {
      return await fn();
    } finally {
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
    }
  }

  async getCursor(name: string): Promise<number> {
    const value = await this.redis.get(`${KEY_PREFIX}cursor:${name}`);
    const parsed = value === null ? 0 : Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  async setCursor(name: string, value: number): Promise<void> {
    await this.redis.set(`${KEY_PREFIX}cursor:${name}`, String(value));
  }

  async markOnce(key: string, ttlS: number): Promise<boolean> {
    const result = await this.redis.set(`${KEY_PREFIX}once:${key}`, '1', 'EX', ttlS, 'NX');
    return result === 'OK';
  }

  async setPending(sessionId: string, value: Record<string, unknown>): Promise<void> {
    await this.redis.hset(PENDING_KEY, sessionId, JSON.stringify(value));
  }

  async clearPending(sessionId: string): Promise<void> {
    await this.redis.hdel(PENDING_KEY, sessionId);
  }

  async listPending(): Promise<Record<string, Record<string, unknown>>> {
    const all = await this.redis.hgetall(PENDING_KEY);
    const out: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(all)) {
      out[key] = JSON.parse(value) as Record<string, unknown>;
    }
    return out;
  }
}

export class MemoryWorkerState implements WorkerState {
  readonly locks = new Set<string>();
  readonly cursors = new Map<string, number>();
  readonly once = new Set<string>();
  readonly pending = new Map<string, Record<string, unknown>>();

  async withLock<T>(name: string, _ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.locks.has(name)) return undefined;
    this.locks.add(name);
    try {
      return await fn();
    } finally {
      this.locks.delete(name);
    }
  }

  getCursor(name: string): Promise<number> {
    return Promise.resolve(this.cursors.get(name) ?? 0);
  }

  setCursor(name: string, value: number): Promise<void> {
    this.cursors.set(name, value);
    return Promise.resolve();
  }

  markOnce(key: string, _ttlS: number): Promise<boolean> {
    if (this.once.has(key)) return Promise.resolve(false);
    this.once.add(key);
    return Promise.resolve(true);
  }

  setPending(sessionId: string, value: Record<string, unknown>): Promise<void> {
    this.pending.set(sessionId, value);
    return Promise.resolve();
  }

  clearPending(sessionId: string): Promise<void> {
    this.pending.delete(sessionId);
    return Promise.resolve();
  }

  listPending(): Promise<Record<string, Record<string, unknown>>> {
    return Promise.resolve(Object.fromEntries(this.pending));
  }
}
