import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, SECRET_FILE_VARIABLES, loadConfig, resolveSecretFiles } from './config.js';

const dir = mkdtempSync(join(tmpdir(), 'ecloud-secret-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function secretFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe('resolveSecretFiles (P10-A, *_FILE secrets)', () => {
  it('resolves SMTP_PASSWORD_FILE into the mail settings (SendGrid shape, STARTTLS on 587)', () => {
    const path = secretFile('smtp_password', 'SG.not-a-real-key.placeholder\n'); // check-no-secrets: allow (test value)
    const out = resolveSecretFiles({ SMTP_PASSWORD_FILE: path });
    expect(out.SMTP_PASSWORD).toBe('SG.not-a-real-key.placeholder');
    expect(out).not.toHaveProperty('SMTP_PASSWORD_FILE');
    const config = loadConfig({
      SMTP_HOST: 'smtp.sendgrid.net',
      SMTP_PORT: '587',
      SMTP_USER: 'apikey',
      SMTP_FROM: 'noreply@example.test',
      SMTP_IMPLICIT_TLS: 'false',
      SMTP_PASSWORD_FILE: path,
    });
    expect(config.mail).toEqual({
      host: 'smtp.sendgrid.net',
      port: 587,
      user: 'apikey',
      password: 'SG.not-a-real-key.placeholder',
      from: 'noreply@example.test',
      implicitTls: false,
    });
    // An empty SMTP_HOST from Compose's `${SMTP_HOST:-}` means "no relay", not a relay at "".
    expect(loadConfig({ SMTP_HOST: '', SMTP_PASSWORD_FILE: path }).mail).toBeNull();
    // A relay without a sender is refused at boot, not at the first OTP.
    expect(() => loadConfig({ SMTP_HOST: 'smtp.sendgrid.net', SMTP_PASSWORD_FILE: path })).toThrow(
      /SMTP_FROM: required when SMTP_HOST is set/,
    );
  });

  it('reads <NAME>_FILE, trims one trailing newline and drops the _FILE key', () => {
    const path = secretFile('internal_api_token', `${'t'.repeat(40)}\n`);
    const out = resolveSecretFiles({ INTERNAL_API_TOKEN_FILE: path, OTHER: 'x' });
    expect(out.INTERNAL_API_TOKEN).toBe('t'.repeat(40));
    expect(out).not.toHaveProperty('INTERNAL_API_TOKEN_FILE');
    expect(out.OTHER).toBe('x');
    // idempotent: resolving the result again changes nothing
    expect(resolveSecretFiles(out)).toEqual(out);
  });

  it('refuses both forms, unreadable and empty files without leaking values or paths', () => {
    const empty = secretFile('empty', '\n');
    const missing = join(dir, 'does-not-exist');
    try {
      resolveSecretFiles({
        VOUCHER_PEPPER: 'inline-value-should-not-leak',
        VOUCHER_PEPPER_FILE: secretFile('pepper', 'p'.repeat(40)),
        MFA_ENCRYPTION_KEY_FILE: missing,
        DATA_ENCRYPTION_KEY_FILE: empty,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { problems, message } = error as ConfigError;
      expect(problems).toEqual([
        'MFA_ENCRYPTION_KEY_FILE: the file cannot be read',
        'DATA_ENCRYPTION_KEY_FILE: the file is empty',
        'VOUCHER_PEPPER_FILE: set either VOUCHER_PEPPER or VOUCHER_PEPPER_FILE, not both',
      ]);
      expect(message).not.toContain('inline-value-should-not-leak');
      expect(message).not.toContain(dir);
    }
  });

  it('ignores _FILE for variables outside the allow-list (RADIUS_SQL_PASSWORD_FILE stays a path)', () => {
    expect(SECRET_FILE_VARIABLES).not.toContain('RADIUS_SQL_PASSWORD');
    const out = resolveSecretFiles({
      RADIUS_SQL_PASSWORD_FILE: '/run/secrets/radius_sql_password',
    });
    expect(out.RADIUS_SQL_PASSWORD_FILE).toBe('/run/secrets/radius_sql_password');
  });

  it('loadConfig accepts production secrets supplied only as files', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL_FILE: secretFile('db', 'postgres://app:pw@db.internal:5432/ecloud\n'),
      DATABASE_URL_PLATFORM_FILE: secretFile('dbp', 'postgres://plat:pw@db.internal:5432/ecloud'),
      REDIS_URL: 'redis://cache.internal:6379',
      INTERNAL_API_TOKEN_FILE: secretFile('tok', 'k'.repeat(48)),
      STORAGE_LOCAL_ALLOW_PRODUCTION: 'true',
    });
    expect(config.internalApiToken).toBe('k'.repeat(48));
    expect(config.database.url).toBe('postgres://app:pw@db.internal:5432/ecloud');
  });
});
