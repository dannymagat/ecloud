import { isUuidV7 } from '@ecloud/shared';
import { describe, expect, it } from 'vitest';
import { makeAdministrator, makeOrganization, makeSite } from './factories.js';

describe('factories', () => {
  it('produce uuid v7 ids, unique slugs and accept overrides', () => {
    const org = makeOrganization({ name: 'Acme' });
    const site = makeSite(org.id, { timezone: 'Europe/London' });
    const admin = makeAdministrator();
    expect(isUuidV7(org.id)).toBe(true);
    expect(isUuidV7(site.id)).toBe(true);
    expect(isUuidV7(admin.id)).toBe(true);
    expect(org.name).toBe('Acme');
    expect(site.organization_id).toBe(org.id);
    expect(site.timezone).toBe('Europe/London');
    expect(makeOrganization().slug).not.toBe(makeOrganization().slug);
    expect(admin.email).toMatch(/@example\.test$/);
  });
});
