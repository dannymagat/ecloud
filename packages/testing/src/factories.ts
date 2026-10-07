import { newId } from '@ecloud/shared';

/**
 * Plain-object fixtures aligned with the @ecloud/db schema (packages/db/migrations). They carry
 * only the columns needed to insert a valid row; tests spread overrides on top.
 */
export interface OrganizationFixture {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'archived';
  settings: Record<string, unknown>;
}

export interface SiteFixture {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  timezone: string;
  status: 'active' | 'suspended' | 'archived';
  settings: Record<string, unknown>;
}

export interface AdministratorFixture {
  id: string;
  email: string;
  display_name: string;
  status: 'invited' | 'active' | 'disabled';
  mfa_enforced: boolean;
}

export interface UserFixture {
  id: string;
  organization_id: string;
  username: string;
  status: 'active' | 'suspended' | 'expired' | 'disabled';
  origin: 'admin' | 'portal_signup' | 'voucher' | 'idp';
}

export interface NasClientFixture {
  id: string;
  organization_id: string;
  site_id: string;
  name: string;
  nas_ip: string;
  adapter_type_key: string;
  secret_ref: string;
}

export interface ClientDeviceFixture {
  id: string;
  organization_id: string;
  mac: string;
}

let sequence = 0;
function next(): number {
  sequence += 1;
  return sequence;
}

export function makeOrganization(
  overrides: Partial<OrganizationFixture> = {},
): OrganizationFixture {
  const n = next();
  return {
    id: newId(),
    slug: `org-${String(n)}`,
    name: `Organization ${String(n)}`,
    status: 'active',
    settings: {},
    ...overrides,
  };
}

export function makeSite(
  organizationId: string,
  overrides: Partial<Omit<SiteFixture, 'organization_id'>> = {},
): SiteFixture {
  const n = next();
  return {
    id: newId(),
    organization_id: organizationId,
    slug: `site-${String(n)}`,
    name: `Site ${String(n)}`,
    timezone: 'UTC',
    status: 'active',
    settings: {},
    ...overrides,
  };
}

export function makeAdministrator(
  overrides: Partial<AdministratorFixture> = {},
): AdministratorFixture {
  const n = next();
  return {
    id: newId(),
    email: `admin${String(n)}@example.test`,
    display_name: `Admin ${String(n)}`,
    status: 'active',
    mfa_enforced: false,
    ...overrides,
  };
}

export function makeUser(
  organizationId: string,
  overrides: Partial<Omit<UserFixture, 'organization_id'>> = {},
): UserFixture {
  const n = next();
  return {
    id: newId(),
    organization_id: organizationId,
    username: `user${String(n)}`,
    status: 'active',
    origin: 'admin',
    ...overrides,
  };
}

/** Test NAS addresses come from the documentation range 192.0.2.0/24 (RFC 5737). */
export function makeNasClient(
  organizationId: string,
  siteId: string,
  overrides: Partial<Omit<NasClientFixture, 'organization_id' | 'site_id'>> = {},
): NasClientFixture {
  const n = next();
  return {
    id: newId(),
    organization_id: organizationId,
    site_id: siteId,
    name: `NAS ${String(n)}`,
    nas_ip: `192.0.2.${String(1 + (n % 250))}`,
    adapter_type_key: 'generic_radius',
    secret_ref: `secret://test/nas-${String(n)}`,
    ...overrides,
  };
}

/** Locally administered unicast MACs (02:xx:...) so fixtures never collide with real hardware. */
export function makeClientDevice(
  organizationId: string,
  overrides: Partial<Omit<ClientDeviceFixture, 'organization_id'>> = {},
): ClientDeviceFixture {
  const n = next();
  const hex = n.toString(16).padStart(8, '0');
  return {
    id: newId(),
    organization_id: organizationId,
    mac: `02:00:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}`,
    ...overrides,
  };
}
