import { TENANT_SCOPED_TABLES } from '@ecloud/db';
import { describe, expect, it } from 'vitest';
import { withDatabaseName, withDatabaseUser, getTestRadiusRoleDatabaseUrl } from './db-urls.js';
import { TENANT_GRAPH_TABLES, tenantTablesMissingFromGraph } from './two-tenants.js';

describe('tenant graph coverage', () => {
  it('seeds exactly the tenant-scoped tables', () => {
    expect(tenantTablesMissingFromGraph()).toEqual([]);
    expect([...TENANT_GRAPH_TABLES].sort()).toEqual([...TENANT_SCOPED_TABLES].sort());
  });

  it('reports tables that have no row builder yet', () => {
    expect(tenantTablesMissingFromGraph([...TENANT_SCOPED_TABLES, 'new_table'])).toEqual([
      'new_table',
    ]);
  });
});

describe('database URL helpers', () => {
  const base = 'postgres://ecloud_platform:pw@127.0.0.1:5432/ecloud_test';

  it('swaps user and database name', () => {
    expect(withDatabaseUser(base, 'ecloud_radius')).toBe(
      'postgres://ecloud_radius:pw@127.0.0.1:5432/ecloud_test',
    );
    expect(withDatabaseName(base, 'ecloud')).toBe(
      'postgres://ecloud_platform:pw@127.0.0.1:5432/ecloud',
    );
  });

  it('derives the radius role URL unless set explicitly', () => {
    expect(getTestRadiusRoleDatabaseUrl({})).toBeUndefined();
    expect(getTestRadiusRoleDatabaseUrl({ ECLOUD_TEST_DATABASE_URL: base })).toBe(
      'postgres://ecloud_radius:pw@127.0.0.1:5432/ecloud_test',
    );
    expect(
      getTestRadiusRoleDatabaseUrl({
        ECLOUD_TEST_DATABASE_URL: base,
        ECLOUD_TEST_RADIUS_ROLE_DATABASE_URL: 'postgres://r@h/x',
      }),
    ).toBe('postgres://r@h/x');
  });
});
