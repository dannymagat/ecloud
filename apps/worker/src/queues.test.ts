import { WORKER_DEAD_LETTER_QUEUES, WORKER_QUEUE_NAMES, WORKER_QUEUE_PREFIX } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import { DEAD_LETTER, QUEUES, QUEUE_PREFIX } from './queues.js';

describe('queue catalogue', () => {
  it('matches the shared list the API health endpoint reports', () => {
    expect(QUEUE_PREFIX).toBe(WORKER_QUEUE_PREFIX);
    expect(Object.values(QUEUES)).toEqual([...WORKER_QUEUE_NAMES]);
    expect([...new Set(Object.values(DEAD_LETTER))].sort()).toEqual(
      [...WORKER_DEAD_LETTER_QUEUES].sort(),
    );
  });
});
