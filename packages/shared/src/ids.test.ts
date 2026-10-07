import { describe, expect, it } from 'vitest';
import { isUuid, isUuidV7, newId } from './ids.js';

describe('ids', () => {
  it('newId returns a UUID v7', () => {
    const id = newId();
    expect(isUuid(id)).toBe(true);
    expect(isUuidV7(id)).toBe(true);
    expect(id).toHaveLength(36);
  });

  it('ids generated in sequence sort ascending (time-ordered)', () => {
    const ids = Array.from({ length: 50 }, () => newId());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('isUuid accepts any RFC 9562 version and rejects garbage', () => {
    expect(isUuid('0f3b9b4e-7b2d-4a6b-9d1e-2b7f8a1c5e10')).toBe(true);
    expect(isUuidV7('0f3b9b4e-7b2d-4a6b-9d1e-2b7f8a1c5e10')).toBe(false);
    expect(isUuid('0f3b9b4e7b2d4a6b9d1e2b7f8a1c5e10')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});
