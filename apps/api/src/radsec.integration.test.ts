/**
 * RadSec NAS identity (RFC 6614, migration 034) against the test database.
 *
 * Over RadSec the shared secret is the literal string "radsec" and the source address belongs
 * to whatever NAT the remote site sits behind, so neither identifies a tenant. The identity is
 * the client certificate EZECLOUD issued, which FreeRADIUS has already verified against the
 * EZECLOUD RadSec CA before the request reaches the API; the policy copies its CN into
 * ECLOUD-TLS-Client-Cert-CN (infra/freeradius/raddb/policy.d/ecloud).
 *
 * These tests pin the properties that make that safe to expose to the internet:
 *   - a verified CN resolves the NAS it names, across tenants;
 *   - the certificate path is DECISIVE: once a CN is present, the source address is never
 *     consulted, so a certificate for NAS A cannot borrow NAS B's address, and an address that
 *     would otherwise resolve cannot rescue a CN that does not;
 *   - a NAS that was never enrolled for RadSec is refused even with a valid certificate CN;
 *   - only the certificate currently enrolled for the NAS (its serial) is accepted, so issuing a
 *     new certificate retires the old one;
 *   - a request from the RadSec client without a certificate identity is refused.
 *
 * Skipped without the dev stack (ECLOUD_TEST_DATABASE_URL).
 */
import { randomBytes } from 'node:crypto';
import {
  describeIntegration,
  migrateTestDatabase,
  PLACEHOLDER_NAS_SECRET_REF,
} from '@ecloud/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppDeps } from './context.js';
import { resolveNas } from './internal/aaa.js';
import type { RadiusRequestBody } from './internal/radius.js';
import { closeDeps, createTenant, integrationDeps, unique } from './test-support/deps.js';

interface Nas {
  id: string;
  orgId: string;
  siteId: string;
  ip: string;
  /** Serial of the certificate enrolled for this NAS (null when not enrolled). */
  serial: string | null;
}

let deps: AppDeps;
/** Rows this suite created, removed in afterAll so repeated runs do not collide. */
const created: string[] = [];

/**
 * A fresh address in the benchmarking range (RFC 2544), which no other suite uses. nas_ip is
 * globally unique, and this database is shared and not reset for this suite, so a hard-coded
 * address would collide with the previous run.
 */
function freeAddress(): string {
  const a = Math.floor(Math.random() * 256);
  const b = 1 + Math.floor(Math.random() * 254);
  return `198.18.${String(a)}.${String(b)}`;
}

/** A NAS row, optionally enrolled for RadSec. */
async function makeNas(
  org: { orgId: string; siteId: string },
  ip: string,
  options: { radsec: boolean; active?: boolean } = { radsec: false },
): Promise<Nas> {
  const serial = randomBytes(16).toString('hex');
  const row = await deps.dbPlatform
    .insertInto('nas_clients')
    .values({
      organization_id: org.orgId,
      site_id: org.siteId,
      name: unique('nas'),
      nas_ip: ip,
      adapter_type_key: 'generic-radius-8021x',
      adapter_key: 'generic-radius-8021x',
      secret_ref: PLACEHOLDER_NAS_SECRET_REF,
      radsec_enabled: options.radsec,
      radsec_cert_serial: options.radsec ? serial : null,
      ...(options.active === false ? { status: 'disabled' as const } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  created.push(String(row.id));
  return {
    id: String(row.id),
    orgId: org.orgId,
    siteId: org.siteId,
    ip,
    serial: options.radsec ? serial : null,
  };
}

/**
 * An Access-Request as the policy builds it: from the RadSec client the CN and serial are present
 * (shortname `ecloud-radsec`), from a UDP client they are not.
 */
function body(input: {
  certCn?: string;
  serial?: string | null;
  srcIp?: string;
  shortname?: string;
}): RadiusRequestBody {
  const body: RadiusRequestBody = { 'User-Name': { value: ['someone@example.invalid'] } };
  if (input.srcIp !== undefined) {
    body['ECLOUD-Packet-Src-IP-Address'] = { value: [input.srcIp] };
  }
  const shortname = input.shortname ?? (input.certCn !== undefined ? 'ecloud-radsec' : undefined);
  if (shortname !== undefined) body['ECLOUD-Client-Shortname'] = { value: [shortname] };
  if (input.certCn !== undefined) {
    body['ECLOUD-TLS-Client-Cert-CN'] = { value: [input.certCn] };
  }
  if (input.serial !== undefined && input.serial !== null) {
    body['ECLOUD-TLS-Client-Cert-Serial'] = { value: [input.serial] };
  }
  return body;
}

/** The request the enrolled certificate of `nas` produces. */
function viaCert(nas: Nas, srcIp?: string): RadiusRequestBody {
  return body({ certCn: nas.id, serial: nas.serial, ...(srcIp === undefined ? {} : { srcIp }) });
}

await describeIntegration('RadSec NAS identity (migration 034)', () => {
  beforeAll(async () => {
    await migrateTestDatabase();
    deps = integrationDeps();
  }, 120_000);

  afterAll(async () => {
    if (created.length > 0) {
      await deps.dbPlatform.deleteFrom('nas_clients').where('id', 'in', created).execute();
    }
    await closeDeps(deps);
  });

  it('resolves the NAS named by a verified certificate CN', async () => {
    const org = await createTenant(deps.dbPlatform);
    const nas = await makeNas(org, freeAddress(), { radsec: true });

    const resolved = await resolveNas(deps, viaCert(nas));
    expect(resolved?.id).toBe(nas.id);
    expect(resolved?.organization_id).toBe(org.orgId);
  });

  it('accepts the OpenSSL spelling of the enrolled serial', async () => {
    const org = await createTenant(deps.dbPlatform);
    const nas = await makeNas(org, freeAddress(), { radsec: true });

    const upper = `0${String(nas.serial).toUpperCase()}`;
    expect((await resolveNas(deps, body({ certCn: nas.id, serial: upper })))?.id).toBe(nas.id);
  });

  it('refuses a certificate other than the one enrolled (rotated or reissued)', async () => {
    const org = await createTenant(deps.dbPlatform);
    const nas = await makeNas(org, freeAddress(), { radsec: true });

    const stale = randomBytes(16).toString('hex');
    expect(await resolveNas(deps, body({ certCn: nas.id, serial: stale }))).toBeNull();
    expect(await resolveNas(deps, body({ certCn: nas.id, serial: null }))).toBeNull();
  });

  it('refuses a NAS enrolled without a recorded certificate serial', async () => {
    const org = await createTenant(deps.dbPlatform);
    const nas = await makeNas(org, freeAddress(), { radsec: true });
    await deps.dbPlatform
      .updateTable('nas_clients')
      .set({ radsec_cert_serial: null })
      .where('id', '=', nas.id)
      .execute();

    expect(await resolveNas(deps, viaCert(nas))).toBeNull();
  });

  it('refuses the RadSec client without a certificate identity, never using the address', async () => {
    const org = await createTenant(deps.dbPlatform);
    const nas = await makeNas(org, freeAddress(), { radsec: false });

    expect(await resolveNas(deps, body({ shortname: 'ecloud-radsec', srcIp: nas.ip }))).toBeNull();
  });

  it('refuses a NAS that was never enrolled for RadSec', async () => {
    const org = await createTenant(deps.dbPlatform);
    // Certificate CN is a real NAS id, but nobody enrolled it: issuing a certificate must be a
    // deliberate act, so a certificate from another purpose cannot impersonate this NAS.
    const nas = await makeNas(org, freeAddress(), { radsec: false });

    // Even presenting a serial is not enough: the row was never enrolled.
    const serial = randomBytes(16).toString('hex');
    expect(await resolveNas(deps, body({ certCn: nas.id, serial }))).toBeNull();
  });

  it('refuses an inactive NAS even with a valid certificate CN', async () => {
    const org = await createTenant(deps.dbPlatform);
    const nas = await makeNas(org, freeAddress(), { radsec: true, active: false });

    expect(await resolveNas(deps, viaCert(nas))).toBeNull();
  });

  it('never falls back to the source address once a certificate identified the request', async () => {
    const org = await createTenant(deps.dbPlatform);
    const enrolled = await makeNas(org, freeAddress(), { radsec: true });
    const other = await makeNas(org, freeAddress(), { radsec: true });

    // The certificate decides, not the address it happens to arrive from: a remote NAS is behind
    // NAT, so the address proves nothing and must not override a verified identity.
    const resolved = await resolveNas(deps, viaCert(enrolled, other.ip));
    expect(resolved?.id).toBe(enrolled.id);

    // And an address that WOULD resolve cannot rescue a CN that does not.
    const unknownCn = '11111111-2222-4333-8444-555555555555';
    expect(
      await resolveNas(deps, body({ certCn: unknownCn, serial: other.serial, srcIp: other.ip })),
    ).toBeNull();
  });

  it('refuses a CN that is not a NAS id, without consulting the address', async () => {
    const org = await createTenant(deps.dbPlatform);
    const nas = await makeNas(org, freeAddress(), { radsec: true });

    for (const cn of ['not-a-uuid', 'nas.example.com', '../../etc/passwd', '']) {
      expect(
        await resolveNas(deps, body({ certCn: cn, serial: nas.serial, srcIp: nas.ip })),
      ).toBeNull();
    }
  });

  it('resolves across tenants by certificate, never by a shared address', async () => {
    const orgA = await createTenant(deps.dbPlatform);
    const orgB = await createTenant(deps.dbPlatform);
    // Both sites sit behind the same public address, which is what NAT at two remote sites
    // looks like. Only the certificate can tell them apart.
    const shared = freeAddress();
    const nasA = await makeNas(orgA, shared, { radsec: true });
    const nasB = await makeNas(orgB, freeAddress(), { radsec: true });

    const a = await resolveNas(deps, viaCert(nasA, shared));
    const b = await resolveNas(deps, viaCert(nasB, shared));
    expect(a?.organization_id).toBe(orgA.orgId);
    expect(b?.organization_id).toBe(orgB.orgId);
    expect(b?.id).toBe(nasB.id);
  });

  it('leaves the UDP path unchanged when no certificate is present', async () => {
    const org = await createTenant(deps.dbPlatform);
    const nas = await makeNas(org, freeAddress(), { radsec: false });

    const resolved = await resolveNas(deps, body({ srcIp: nas.ip }));
    expect(resolved?.id).toBe(nas.id);
  });
});
