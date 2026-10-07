import { describe, expect, it } from 'vitest';
import { isLost, lastSeen, reapCutoff } from './reap.js';

describe('session reaper rule', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  it('cutoff = now − (2 × interval + grace)', () => {
    expect(reapCutoff(now, 600, 120)).toEqual(new Date('2026-01-01T11:38:00Z'));
  });
  it('uses the last interim, else the start time', () => {
    const started = new Date('2026-01-01T10:00:00Z');
    expect(lastSeen({ started_at: started, last_interim_at: null })).toBe(started);
    const interim = new Date('2026-01-01T11:50:00Z');
    expect(lastSeen({ started_at: started, last_interim_at: interim })).toBe(interim);
  });
  it('a session is lost only strictly beyond the threshold', () => {
    const started = new Date('2026-01-01T09:00:00Z');
    expect(
      isLost(
        { started_at: started, last_interim_at: new Date('2026-01-01T11:38:00Z') },
        now,
        600,
        120,
      ),
    ).toBe(false);
    expect(
      isLost(
        { started_at: started, last_interim_at: new Date('2026-01-01T11:37:59Z') },
        now,
        600,
        120,
      ),
    ).toBe(true);
    expect(
      isLost(
        { started_at: new Date('2026-01-01T11:59:00Z'), last_interim_at: null },
        now,
        600,
        120,
      ),
    ).toBe(false);
  });
});
