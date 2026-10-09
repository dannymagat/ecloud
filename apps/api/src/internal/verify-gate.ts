/**
 * Bounded admission for subscriber Argon2id verifies (B-3, docs/PERFORMANCE.md).
 *
 * Before B-3 the verify ran inside the tenant transaction, so overload was bounded by the pg pool:
 * a request that could not get a connection within `connectionTimeoutMillis` (5 s) failed closed
 * with 503. With the verify moved outside the transaction nothing bounded the queue any more: at
 * 20 password logins/s on 0.75 CPU (above the B-2 Argon2id ceiling) requests queued for 10-14 s
 * and were still accepted long after FreeRADIUS (`rlm_rest` timeout 1.5 s) had given up, burning
 * CPU on abandoned work. This gate restores the old overload semantics without holding a
 * connection: at most `concurrency` verifies run at once (default: the libuv threadpool size
 * Argon2 runs on), and a verify that cannot start within `maxWaitMs` (default 5 s, the old pool
 * wait) throws {@link VerifyGateTimeout}, which the AAA and portal handlers turn into their
 * existing fail-closed 503 (never an accept, never a credential reject).
 */
export class VerifyGateTimeout extends Error {
  constructor() {
    super('password verification queue wait exceeded');
    this.name = 'VerifyGateTimeout';
  }
}

interface Waiter {
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class VerifyGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  /**
   * @param maxQueue waiting verifies beyond this are refused at once (review B-3 #2): bounds
   *   memory/timers under a flood and stops one tenant's burst from queueing everyone else out.
   */
  constructor(
    readonly concurrency: number,
    readonly maxWaitMs: number,
    readonly maxQueue: number = concurrency * 8,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError('VerifyGate concurrency must be a positive integer');
    }
  }

  /** Verifies currently running / waiting (for tests and diagnostics). */
  get stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiters.length };
  }

  /** `maxWaitMs` per call: the AAA path uses a shorter deadline than the portal (see below). */
  async run<T>(fn: () => Promise<T>, maxWaitMs: number = this.maxWaitMs): Promise<T> {
    await this.acquire(maxWaitMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(maxWaitMs: number): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueue) return Promise.reject(new VerifyGateTimeout());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new VerifyGateTimeout());
        }, maxWaitMs),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    // Hand the slot straight to the next waiter (active count unchanged), else free it.
    if (next !== undefined) next.start();
    else this.active -= 1;
  }
}

function threadpoolSize(): number {
  const n = Number(process.env.UV_THREADPOOL_SIZE);
  return Number.isInteger(n) && n >= 1 ? n : 4;
}

/**
 * AAA (FreeRADIUS rlm_rest) queue deadline. FreeRADIUS gives up after ~1.5 s, so a verify that
 * starts later would create a session nobody receives (review B-3 #1). 1 s leaves ~0.5 s for the
 * ~45 ms verify, the decision transaction and the reply; past it the api answers 503 → reject.
 * The portal keeps the 5 s default (a browser waits).
 */
export const AAA_VERIFY_MAX_WAIT_MS = 1_000;

/** Process-wide gate shared by AAA authorize and the portal identity broker. */
export const passwordVerifyGate = new VerifyGate(threadpoolSize(), 5_000);
