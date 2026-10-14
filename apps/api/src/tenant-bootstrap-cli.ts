#!/usr/bin/env node
/**
 * CLI for `bootstrap/tenant.ts` — creates the minimum rows a NAS needs before a guest can reach
 * the internet, including the two shared secrets no API route can set.
 *
 * NOTHING SECRET IS BAKED IN. Every secret comes from the environment and exists only in the
 * operator's shell:
 *
 *   BOOTSTRAP_RADIUS_SECRET    RADIUS shared secret for the NAS row
 *   BOOTSTRAP_UAM_SECRET       UAM signing secret for the portal row
 *   BOOTSTRAP_USER_PASSWORD    sample user's password; hashed here, never stored in clear
 *
 * and the usual platform configuration:
 *
 *   DATABASE_URL_PLATFORM      platform (BYPASSRLS) connection
 *   DATA_ENCRYPTION_KEY        the key that seals nas_clients.secret_ref and uam_secret_ref
 *
 * THIS WRITES TO WHATEVER DATABASE YOU POINT IT AT. It is idempotent, so a second run
 * reconciles rather than duplicates, but it is not a dry run and there is no confirmation
 * prompt. Point it at a development database first.
 *
 * Exit codes: 0 bootstrapped, 1 database or write failure (the transaction rolled back, so the
 * tenant is unchanged), 2 configuration error. One JSON summary line on stdout; errors on
 * stderr. Neither ever contains a secret, a password or a connection string.
 */
import { createDb, hashPassword } from '@ecloud/db';
import { resolveSecretFiles } from '@ecloud/shared';
import { bootstrapTenant, type BootstrapInput } from './bootstrap/tenant.js';

const DEFAULTS = {
  siteName: 'EZELINK-HQ',
  siteSlug: 'ezelink-hq',
  timezone: 'Asia/Dubai',
  nasName: 'EZELINK',
  portalName: 'EZELINK',
  portalSlug: 'ezelink',
  networkRef: 'default',
  policyName: 'EZELINK Default',
  username: 'sample',
  downloadKbps: 10_000,
  uploadKbps: 10_000,
  userValidDays: 1,
  walledGarden: ['portal.ezelink.ai', 'ezecloud.ezelink.ai'],
} as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

async function main(): Promise<number> {
  const env = resolveSecretFiles(process.env);

  let databaseUrl: string;
  let dataEncryptionKey: string;
  let radiusSecret: string;
  let uamSecret: string;
  let password: string;
  let organizationId: string;
  try {
    databaseUrl = required(env, 'DATABASE_URL_PLATFORM');
    dataEncryptionKey = required(env, 'DATA_ENCRYPTION_KEY');
    radiusSecret = required(env, 'BOOTSTRAP_RADIUS_SECRET');
    uamSecret = required(env, 'BOOTSTRAP_UAM_SECRET');
    password = required(env, 'BOOTSTRAP_USER_PASSWORD');
    organizationId = required(env, 'BOOTSTRAP_ORGANIZATION_ID');
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const nasIdentifier = required(env, 'BOOTSTRAP_NAS_IDENTIFIER');
  const nasIp = required(env, 'BOOTSTRAP_NAS_IP');
  const adapterKey = optional(env, 'BOOTSTRAP_ADAPTER_KEY', 'openwifi-uspot-uam');
  const username = optional(env, 'BOOTSTRAP_USERNAME', DEFAULTS.username);

  const db = createDb(databaseUrl);
  try {
    const passwordHash = await hashPassword(password);
    const input: BootstrapInput = {
      organizationId,
      siteName: optional(env, 'BOOTSTRAP_SITE_NAME', DEFAULTS.siteName),
      siteSlug: optional(env, 'BOOTSTRAP_SITE_SLUG', DEFAULTS.siteSlug),
      timezone: optional(env, 'BOOTSTRAP_TIMEZONE', DEFAULTS.timezone),
      nasName: optional(env, 'BOOTSTRAP_NAS_NAME', DEFAULTS.nasName),
      nasIdentifier,
      nasIp,
      adapterKey,
      radiusSecret,
      uamSecret,
      // Recorded in the audit trail so a later reader knows a dictionary-word secret was a
      // decision and not an oversight. Set to `false` when seeding a tenant-specific value.
      secretsArePlatformDefaults: optional(env, 'BOOTSTRAP_SECRETS_ARE_DEFAULTS', 'true') !== 'false',
      portalName: optional(env, 'BOOTSTRAP_PORTAL_NAME', DEFAULTS.portalName),
      portalSlug: optional(env, 'BOOTSTRAP_PORTAL_SLUG', DEFAULTS.portalSlug),
      networkRef: optional(env, 'BOOTSTRAP_NETWORK_REF', DEFAULTS.networkRef),
      walledGarden: [...DEFAULTS.walledGarden],
      policyName: optional(env, 'BOOTSTRAP_POLICY_NAME', DEFAULTS.policyName),
      downloadKbps: Number(optional(env, 'BOOTSTRAP_DOWNLOAD_KBPS', String(DEFAULTS.downloadKbps))),
      uploadKbps: Number(optional(env, 'BOOTSTRAP_UPLOAD_KBPS', String(DEFAULTS.uploadKbps))),
      username,
      passwordHash,
      userValidDays: Number(optional(env, 'BOOTSTRAP_USER_VALID_DAYS', String(DEFAULTS.userValidDays))),
      dataEncryptionKey,
      now: new Date(),
    };

    // One transaction: a half-bootstrapped tenant is the state this exists to prevent.
    const steps = await db.transaction().execute((trx) => bootstrapTenant(trx, input));

    process.stdout.write(
      `${JSON.stringify({
        event: 'tenant_bootstrapped',
        organization_id: organizationId,
        username,
        nas_identifier: nasIdentifier,
        nas_ip: nasIp,
        adapter_key: adapterKey,
        steps,
      })}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`bootstrap failed, nothing written: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await db.destroy();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`bootstrap failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
