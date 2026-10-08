/**
 * L3 relocation guard (MULTI_VENDOR_INTEGRATION_PLAN.md §8.2): the worker's accounting
 * normaliser IS the `@ecloud/adapters` implementation (no second copy), and the status unions the
 * adapters package inlines are exactly the `@ecloud/db` column types.
 */
import * as adapters from '@ecloud/adapters';
import type {
  AccountingStatusType as DbAccountingStatusType,
  RadiusAcctStatusType as DbRadiusAcctStatusType,
} from '@ecloud/db';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as worker from './normalize.js';

describe('accounting normaliser relocation', () => {
  it('re-exports the adapters implementation by reference', () => {
    expect(worker.normalizeAccounting).toBe(adapters.normalizeAccounting);
    expect(worker.counterDelta).toBe(adapters.counterDelta);
    expect(worker.maxCounters).toBe(adapters.maxCounters);
    expect(worker.mapStatusType).toBe(adapters.mapStatusType);
    expect(worker.deriveTimes).toBe(adapters.deriveTimes);
    expect(worker.parseClassSessionId).toBe(adapters.parseClassSessionId);
    expect(worker.normalizeMacAddress).toBe(adapters.normalizeMacAddress);
    expect(worker.normalizeTerminateCause).toBe(adapters.normalizeTerminateCause);
    expect(worker.EVENT_TIME_TOLERANCE_MS).toBe(adapters.EVENT_TIME_TOLERANCE_MS);
  });

  it('inlined status unions equal the @ecloud/db column types', () => {
    expectTypeOf<adapters.AccountingStatusType>().toEqualTypeOf<DbAccountingStatusType>();
    expectTypeOf<adapters.RadiusAcctStatusType>().toEqualTypeOf<DbRadiusAcctStatusType>();
  });
});
