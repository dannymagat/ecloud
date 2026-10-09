/**
 * P10-B: a terminated idle backend (what a PostgreSQL restart does to every pooled connection)
 * must not crash the process; the pool reconnects on the next query. Runs against
 * `ECLOUD_TEST_DATABASE_URL`; skips cleanly when it is unset. Terminates only its OWN backend.
 */
import { describeIntegration, getTestDatabaseUrl } from '@ecloud/testing';
import { expect, it } from 'vitest';
import { createPool } from './client.js';

await describeIntegration('pg pool survives a terminated idle connection', () => {
  it('emits a handled idle error and serves the next query on a new backend', async () => {
    const url = getTestDatabaseUrl() ?? '';
    const errors: Error[] = [];
    const pool = createPool(url, { max: 1, onIdleError: (e) => errors.push(e) });
    const killer = createPool(url, { max: 1 });
    try {
      const first = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = first.rows[0]?.pid;
      expect(pid).toBeTypeOf('number');
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      await expect.poll(() => errors.length, { timeout: 5_000 }).toBeGreaterThan(0);
      const second = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(second.rows[0]?.pid).not.toBe(pid);
    } finally {
      await Promise.all([pool.end(), killer.end()]);
    }
  });
});
