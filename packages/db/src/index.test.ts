import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@ecloud/db', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@ecloud/db');
  });
});
