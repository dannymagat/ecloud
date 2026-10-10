#!/usr/bin/env node
/**
 * ecloud-radius-clients: renders the FreeRADIUS NAS allow-list from `nas_clients`
 * (docs/SECURITY_REVIEW_P10.md F-P10-07). One-shot; run before (re)starting FreeRADIUS:
 *
 *   node apps/api/dist/radius-clients-cli.js [--check] [--out /abs/path/ecloud-nas.conf]
 *
 *   --check   load, decrypt and validate everything, write nothing
 *   --out     override RADIUS_CLIENTS_FILE
 *
 * FreeRADIUS 3.2 reads clients only at start-up (SIGHUP re-reads modules, not clients), so a
 * changed file takes effect with a container restart: see infra/freeradius/README.md.
 * Environment and exit codes (0 ok, 1 failed + previous file kept, 2 config, 3 written with
 * skipped rows): radius-clients/run.ts.
 */
import { createDb } from '@ecloud/db';
import { ConfigError } from '@ecloud/shared';
import { parseArgs } from 'node:util';
import { loadNasClientRows, resolveNasSecrets } from './radius-clients/load.js';
import { loadMerakiEntries as loadMeraki } from './radius-clients/meraki.js';
import {
  EXIT_SKIPPED,
  describeRenderError,
  loadRenderSettings,
  renderRadiusClients,
  type RenderSettings,
} from './radius-clients/run.js';

async function loadEntries(settings: RenderSettings) {
  const db = createDb(settings.databaseUrlPlatform, { max: 1 });
  try {
    const rows = await loadNasClientRows(db);
    return resolveNasSecrets(rows, settings.dataEncryptionKey);
  } finally {
    await db.destroy();
  }
}

async function loadMerakiEntries(settings: RenderSettings) {
  const db = createDb(settings.databaseUrlPlatform, { max: 1 });
  try {
    return await loadMeraki(db, settings.dataEncryptionKey);
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<number> {
  let values: { check?: boolean; out?: string };
  try {
    ({ values } = parseArgs({
      options: { check: { type: 'boolean' }, out: { type: 'string' } },
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write('usage: radius-clients-cli [--check] [--out <absolute path>]\n');
    return 2;
  }
  let settings: RenderSettings;
  try {
    settings = loadRenderSettings(process.env, values.out);
  } catch (error) {
    process.stderr.write(`radius-clients: ${describeRenderError(error)}\n`);
    return error instanceof ConfigError ? 2 : 1;
  }
  try {
    const summary = await renderRadiusClients(
      settings,
      { loadEntries, loadMerakiEntries },
      { checkOnly: values.check === true },
    );
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    const merakiSkipped = summary.meraki?.skipped.count ?? 0;
    if (merakiSkipped > 0) {
      process.stderr.write(
        `radius-clients: ${String(merakiSkipped)} Meraki NAS row(s) skipped (see "meraki.skipped")\n`,
      );
    }
    if (summary.skipped.count > 0 || merakiSkipped > 0) {
      process.stderr.write(
        `radius-clients: ${String(summary.skipped.count)} NAS row(s) skipped (see "skipped"); the file ${summary.checkOnly ? 'would hold' : 'holds'} the ${String(summary.clients)} valid client(s)\n`,
      );
      return EXIT_SKIPPED;
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `radius-clients: render failed, previous file kept: ${describeRenderError(error)}\n`,
    );
    return 1;
  }
}

process.exitCode = await main();
