/**
 * L4 simulator — UAM redirect parse / context validation (MULTI_VENDOR_INTEGRATION_PLAN.md §8.3
 * SIM-01…SIM-04, SIM-07, SIM-08) for `openwifi-uspot-uam` (uspot TIP redirect shape) and
 * `coovachilli-uam` (CoovaChilli `redir.c` shape). The simulated NAS is `@ecloud/testing`
 * `buildUamRedirect`, written independently of `@ecloud/adapters`.
 *
 * Simulator evidence: ECLOUD code behaviour only, NOT hardware compatibility.
 */
import { describe, expect, it } from 'vitest';
import { signUamQuery, SIM_UAM_SECRET } from '@ecloud/testing';
import {
  CLIENT_MAC,
  ORG_A,
  TARGETS,
  credential,
  memoryLookup,
  parse,
  redirect,
  redirectInput,
  validContext,
} from './support.js';

for (const t of TARGETS) {
  const tag = `[${t.adapterKey}]`;

  describe(`UAM redirect ${tag}`, () => {
    it(`SIM-01 ${tag} valid res=notyet redirect with correct md parses and validates`, async () => {
      const r = redirect(t);
      const parsed = parse(t, r.url);
      expect(parsed.result).toBe('notyet');
      expect(parsed.signature).toEqual({ kind: 'uam-md5', value: r.md });
      expect(parsed.params.nasid).toBe(t.nas.identifier);
      const v = await t.adapter.validateContext(parsed, memoryLookup([t.nas]));
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.context).toMatchObject({
        organizationId: ORG_A,
        siteId: t.nas.siteId,
        clientMac: CLIENT_MAC,
        apMac: '00:11:22:33:44:55',
        nasSessionId: '5f3c2a1b0d9e8f70',
        deploymentMode: t.nas.deploymentMode,
        nas: { id: t.nas.id, adapterKey: t.adapterKey },
      });
      // md comparison is case-insensitive (CP §7.3): a lowercase md from the device still passes.
      const lower = `${r.signedQuery}&md=${(r.md ?? '').toLowerCase()}`;
      const v2 = await t.adapter.validateContext(
        parse(t, `${t.uamServer}?${lower}`),
        memoryLookup([t.nas]),
      );
      expect(v2.ok).toBe(true);
    });

    it(`SIM-02 ${tag} forged md (wrong secret, garbage, missing) → bad_signature, no hand-off`, async () => {
      const forgedSecret = redirect(t, { uamSecret: 'attacker-guess-fake' });
      const missing = redirect(t, { uamSecret: null });
      const garbage = `${redirect(t).signedQuery}&md=${'0'.repeat(32)}`;
      for (const url of [forgedSecret.url, missing.url, `${t.uamServer}?${garbage}`]) {
        const v = await t.adapter.validateContext(parse(t, url), memoryLookup([t.nas]));
        expect(v).toMatchObject({ ok: false, reason: 'bad_signature' });
      }
      // A NAS registered without a UAM secret never yields a context either (fail closed).
      const unsignedNas = { ...t.nas, uamSecret: null };
      const v = await t.adapter.validateContext(parse(t, missing.url), memoryLookup([unsignedNas]));
      expect(v).toMatchObject({ ok: false, reason: 'bad_signature' });
    });

    it(`SIM-03 ${tag} parameter tampered after signing (mac, nasid, uamip) → bad_signature`, async () => {
      const r = redirect(t);
      const tampered = [
        r.query.replace(`mac=${encodeURIComponent('AA-BB-CC-DD-EE-01')}`, 'mac=AA-BB-CC-DD-EE-99'),
        r.query.replace(/nasid=[^&]+/, 'nasid=sim-nas-other'),
        r.query.replace('uamip=10.1.0.1', 'uamip=10.1.0.2'),
        r.query.replace('uamport=3990', 'uamport=3991'),
        r.query.replace('challenge=0123', 'challenge=f123'),
      ];
      for (const q of tampered) {
        expect(q).not.toBe(r.query);
        const nasList = [t.nas, { ...t.nas, id: 'sim-nas-other', identifier: 'sim-nas-other' }];
        const v = await t.adapter.validateContext(
          parse(t, `${t.uamServer}?${q}`),
          memoryLookup(nasList),
        );
        expect(v).toMatchObject({ ok: false, reason: 'bad_signature' });
      }
      // Appending a second `mac` after `md` (parameter pollution) is refused, never trusted.
      const polluted = `${r.query}&mac=AA-BB-CC-DD-EE-99`;
      const v = await t.adapter.validateContext(
        parse(t, `${t.uamServer}?${polluted}`),
        memoryLookup([t.nas]),
      );
      expect(v.ok).toBe(false);
    });

    it(`SIM-04 ${tag} unknown nasid / NAS of another adapter → unknown_nas, no tenant data`, async () => {
      const r = redirect(t, { nasid: 'sim-nas-unregistered', called: '00-00-5E-00-53-01' });
      const v = await t.adapter.validateContext(parse(t, r.url), memoryLookup([t.nas]));
      expect(v).toMatchObject({ ok: false, reason: 'unknown_nas' });
      if (v.ok) return;
      const text = JSON.stringify(v);
      expect(text).not.toContain(ORG_A);
      expect(text).not.toContain(t.nas.siteId);
      expect(text).not.toContain(SIM_UAM_SECRET);
      // Registered, but for another adapter: also unknown_nas (no cross-adapter context).
      const other = TARGETS.find((x) => x.adapterKey !== t.adapterKey);
      if (!other) throw new Error('need two targets');
      const wrong = { ...other.nas, identifier: t.nas.identifier, uamServerUrl: t.uamServer };
      const v2 = await t.adapter.validateContext(parse(t, redirect(t).url), memoryLookup([wrong]));
      expect(v2).toMatchObject({ ok: false, reason: 'unknown_nas' });
    });

    it(`SIM-07 ${tag} public / malformed uamip → private_address_required`, async () => {
      for (const uamip of ['203.0.113.10', '8.8.8.8', '127.0.0.1', '169.254.1.1', '10.1.0']) {
        const v = await t.adapter.validateContext(
          parse(t, redirect(t, { uamip }).url),
          memoryLookup([t.nas]),
        );
        expect(v).toMatchObject({ ok: false, reason: 'private_address_required' });
      }
      for (const uamip of ['10.1.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1']) {
        const v = await t.adapter.validateContext(
          parse(t, redirect(t, { uamip }).url),
          memoryLookup([t.nas]),
        );
        expect(v.ok).toBe(true);
      }
    });

    it(`SIM-07 ${tag} hostile userurl payloads are replaced by the landing page in the hand-off`, async () => {
      const hostile = [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'http://user:pw-fake@example.com/',
        `http://example.com/${'a'.repeat(2100)}`,
        'http://10.0.0.5/admin',
        'http://192.168.1.1/',
        'http://10.1.0.1:3990/logoff',
        'http://127.0.0.1/',
        'http://localhost/',
        'http://[::1]/',
        'http://[::ffff:10.0.0.1]/',
        'http://169.254.169.254/latest/meta-data/',
        'http://2130706433/',
        'http://0.0.0.0/',
        'http://100.64.0.1/',
        'http://[fd00::1]/',
        'http://[fe80::1]/',
        'http://[::]/',
        'http://[0:0:0:0:0:ffff:7f00:1]/',
        'http://localhost./',
        'http://0x7f.1/',
        'ftp://example.com/',
        '//evil.example/',
        // Backslash open-redirect variants (browsers treat `\\` as `/` in special URLs).
        'http:\\\\evil.example',
        'https:/\\evil.example/',
        'http://evil\\@x',
        '/\\evil.example',
        '\\\\evil.example',
        '/\\/evil.example/',
      ];
      for (const userurl of hostile) {
        const ctx = await validContext(t, redirect(t, { userurl }).url);
        const h = t.adapter.authorizeSession(ctx, credential(t), { uamSecret: SIM_UAM_SECRET });
        if ('unsupported' in h) throw new Error(h.reason);
        expect(h.browser?.fields.userurl, userurl).toBeUndefined();
        expect(h.browser?.url, userurl).not.toContain('userurl=');
      }
      const ctx = await validContext(t, redirect(t, { userurl: 'https://example.com/ok' }).url);
      const h = t.adapter.authorizeSession(ctx, credential(t), { uamSecret: SIM_UAM_SECRET });
      if ('unsupported' in h) throw new Error(h.reason);
      expect(h.browser?.fields.userurl).toBe('https://example.com/ok');
    });

    it(`SIM-08 ${tag} raw query preserved byte-for-byte incl. percent-encoded binary`, async () => {
      // Percent-encoded binary in an opaque value plus (uspot T) an un-encoded userurl with
      // `&`, `=`, `%` sequences that are not valid UTF-8.
      const userurl =
        t.flavour === 'uspot-tip'
          ? 'http://example.com/p?q=%e9%ff&x=1=2&y'
          : 'http://example.com/p?q=é&x=1=2&y';
      const base = redirect(t, { userurl });
      const signed = signUamQuery(
        t.uamServer,
        base.signedQuery.replace('ssid=Guest', 'ssid=%00%FF%e9%2B+x'),
        SIM_UAM_SECRET,
      );
      const url = `${t.uamServer}?${signed}`;
      const parsed = parse(t, url);
      expect(parsed.rawQuery).toBe(signed);
      expect(Buffer.from(parsed.rawQuery, 'latin1').equals(Buffer.from(signed, 'latin1'))).toBe(
        true,
      );
      const v = await t.adapter.validateContext(parsed, memoryLookup([t.nas]));
      if (!v.ok) throw new Error(`${v.reason}: ${v.detail}`);
      expect(v.context.vendorOpaque.raw).toBe(signed);
      expect(JSON.stringify(v.context.vendorOpaque)).not.toContain(SIM_UAM_SECRET);
      // uspot T: everything after `userurl=` up to `&md=` is the raw userurl; CoovaChilli's
      // percent-encoded userurl decodes to the original.
      expect(parsed.params.userurl).toBe(userurl);
      // The hand-off carries the (safe) userurl unchanged in meaning: decoding the hand-off
      // field yields the same URL the device reported.
      const h = t.adapter.authorizeSession(v.context, credential(t), { uamSecret: SIM_UAM_SECRET });
      if ('unsupported' in h) throw new Error(h.reason);
      const handed = new URL(h.browser?.url ?? '').searchParams.get('userurl');
      expect(handed).toBe(new URL(parsed.params.userurl ?? '').toString());
    });

    it(`SIM-08 ${tag} redirect fixtures carry documented parameters only`, () => {
      const documented = new Set([
        'res',
        'uamip',
        'uamport',
        'challenge',
        'mac',
        'ip',
        'called',
        'nasid',
        'ssid',
        'sessionid',
        'userurl',
        'md',
      ]);
      const parsed = parse(t, redirect(t).url);
      for (const k of Object.keys(parsed.params)) expect(documented.has(k), k).toBe(true);
      expect(redirectInput(t).uamSecret).toBe(SIM_UAM_SECRET);
    });
  });
}
