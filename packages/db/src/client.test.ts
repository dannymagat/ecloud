import { describe, expect, it, vi } from 'vitest';
import { createPool } from './client.js';

describe('createPool (P10-B resilience)', () => {
  it('always handles idle-client errors so a PostgreSQL restart cannot crash the process', async () => {
    const onIdleError = vi.fn();
    const pool = createPool('postgres://nobody:nothing@127.0.0.1:1/none', { onIdleError });
    expect(pool.listenerCount('error')).toBe(1);
    const error = new Error('terminating connection due to administrator command');
    expect(() => pool.emit('error', error)).not.toThrow();
    expect(onIdleError).toHaveBeenCalledWith(error);
    const silent = createPool('postgres://nobody:nothing@127.0.0.1:1/none');
    expect(() => silent.emit('error', error)).not.toThrow();
    await Promise.all([pool.end(), silent.end()]);
  });
});
