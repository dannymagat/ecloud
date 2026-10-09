import { describe, expect, it, vi } from 'vitest';
import { VerifyGate, VerifyGateTimeout } from './verify-gate.js';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('VerifyGate (bounded Argon2id admission, B-3)', () => {
  it('runs at most `concurrency` tasks at once and hands slots over in FIFO order', async () => {
    const gate = new VerifyGate(2, 10_000);
    const order: number[] = [];
    const blockers = [deferred(), deferred(), deferred()];
    const runs = blockers.map((b, i) =>
      gate.run(async () => {
        order.push(i);
        await b.promise;
        return i;
      }),
    );
    await Promise.resolve();
    expect(gate.stats).toEqual({ active: 2, waiting: 1 });
    expect(order).toEqual([0, 1]);
    blockers[0]?.resolve();
    await runs[0];
    await vi.waitFor(() => expect(order).toEqual([0, 1, 2]));
    expect(gate.stats).toEqual({ active: 2, waiting: 0 });
    blockers[1]?.resolve();
    blockers[2]?.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(gate.stats).toEqual({ active: 0, waiting: 0 });
  });

  it('a task that cannot start within maxWaitMs fails with VerifyGateTimeout and never runs', async () => {
    vi.useFakeTimers();
    try {
      const gate = new VerifyGate(1, 5_000);
      const hold = deferred();
      const first = gate.run(() => hold.promise);
      const task = vi.fn(() => Promise.resolve(true));
      const second = gate.run(task);
      const settled = expect(second).rejects.toBeInstanceOf(VerifyGateTimeout);
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
      expect(task).not.toHaveBeenCalled();
      expect(gate.stats).toEqual({ active: 1, waiting: 0 });
      hold.resolve();
      await first;
      expect(gate.stats).toEqual({ active: 0, waiting: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing task releases its slot', async () => {
    const gate = new VerifyGate(1, 1_000);
    await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(gate.stats).toEqual({ active: 0, waiting: 0 });
    expect(await gate.run(() => Promise.resolve('ok'))).toBe('ok');
  });

  it('a per-call maxWaitMs overrides the default deadline', async () => {
    vi.useFakeTimers();
    try {
      const gate = new VerifyGate(1, 5_000);
      let release: () => void = () => undefined;
      const first = gate.run(() => new Promise<void>((r) => (release = r)));
      const ran = vi.fn();
      const second = gate.run(() => Promise.resolve(ran()), 1_000);
      const settled = expect(second).rejects.toBeInstanceOf(VerifyGateTimeout);
      await vi.advanceTimersByTimeAsync(1_000);
      await settled;
      expect(ran).not.toHaveBeenCalled();
      release();
      await first;
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses at once when the wait queue is full (bounded memory, no starvation of others)', async () => {
    const gate = new VerifyGate(1, 60_000, 2);
    let release: () => void = () => undefined;
    const first = gate.run(() => new Promise<void>((r) => (release = r)));
    const q1 = gate.run(() => Promise.resolve(1));
    const q2 = gate.run(() => Promise.resolve(2));
    expect(gate.stats).toEqual({ active: 1, waiting: 2 });
    await expect(gate.run(() => Promise.resolve(3))).rejects.toBeInstanceOf(VerifyGateTimeout);
    release();
    await first;
    expect(await Promise.all([q1, q2])).toEqual([1, 2]);
    expect(gate.stats).toEqual({ active: 0, waiting: 0 });
  });

  it('rejects a non-positive concurrency', () => {
    expect(() => new VerifyGate(0, 1_000)).toThrow(RangeError);
  });
});
