/**
 * L4 simulator — authorization hand-off, policy degradation and Disconnect build
 * (MULTI_VENDOR_INTEGRATION_PLAN.md §8.3 SIM-09, SIM-15, SIM-16).
 *
 * Reference vectors were computed outside this code base (Python `hashlib`, 2026-10-08) from the
 * CAPTIVE_PORTAL_ARCHITECTURE.md §3.3 / §7.4 formulas with the fake secret `uam-test-secret-fake`
 * and challenge 0123456789abcdef0123456789abcdef; the simulator's own reference functions are
 * checked against them too, so neither implementation is trusted alone.
 *
 * Simulator evidence: ECLOUD code behaviour only, NOT hardware compatibility. Disconnect stays
 * REQUIRES_DEVICE_TEST (D-006) whatever happens here.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPATIBILITY_ROWS,
  encodeUamPapPassword,
  getAdapter,
  presentCells,
  type AuthorizationPlan,
} from '@ecloud/adapters';
import { RADIUS_UINT32_MAX } from '@ecloud/policy-engine';
import {
  SIM_UAM_SECRET,
  deviceDecodePapTip,
  deviceDecodePapUpstream,
  parseDeviceLogon,
  referenceChapResponse,
  referencePapEncode,
} from '@ecloud/testing';
import {
  CHALLENGE,
  TARGETS,
  credential,
  effectiveFor,
  redirect,
  validContext,
  type SimTarget,
} from './support.js';

/** password → [PAP hex, CHAP hex] (Python hashlib, see header). */
const VECTORS: Readonly<Record<string, readonly [string, string]>> = {
  'pc-pass-01': ['cac9faf9b2dc2d086f936233fd61807a', '0b0eecc74b4e5b895303df40436c5559'],
  'sixteen-bytes-pw': ['c9c3affdb6ca30083ddb16568e4cf00d', '54db0e5324e6e37957b1ea662d29c0b0'],
  a: ['dbaad789d3af5e255fa26233fd61807a', 'b18539d3689fa31e8cd4b9de39a2bac0'],
};

async function plan(
  t: SimTarget,
  fields: Record<string, unknown>,
  degradation?: 'fallback_ecloud_side' | 'allow_and_flag' | 'strict_reject',
  critical: readonly string[] = [],
): Promise<AuthorizationPlan> {
  const { effective, tctx } = effectiveFor(fields, critical);
  const p = t.adapter.buildAuthorization(
    await validContext(t),
    credential(t),
    effective,
    tctx(degradation),
    { uamSecret: SIM_UAM_SECRET },
  );
  if ('unsupported' in p) throw new Error(p.reason);
  return p;
}

/** Independent expectation for `gatewaySuggestion` (plan §6.2): a gateway row presenting every field VERIFIED. */
function expectedSuggestion(t: SimTarget, fieldsUnenforceable: readonly string[]): string | null {
  if (fieldsUnenforceable.length === 0 || t.adapterKey === 'coovachilli-uam') return null;
  const row = COMPATIBILITY_ROWS.find(
    (r) =>
      r.lifecycle !== 'planned' &&
      r.lifecycle !== 'researched' &&
      r.deploymentModes.includes('gateway') &&
      fieldsUnenforceable.every((f) =>
        presentCells(r.capabilities).some(
          (c) => c.capability === f && c.status === 'VERIFIED_SUPPORTED',
        ),
      ),
  );
  return row?.key ?? null;
}

describe('reference vectors (simulator self-check)', () => {
  it('SIM-09 simulator PAP/CHAP references equal the externally computed vectors', () => {
    for (const [pw, [pap, chap]] of Object.entries(VECTORS)) {
      expect(referencePapEncode(pw, CHALLENGE, SIM_UAM_SECRET)).toBe(pap);
      expect(referenceChapResponse(pw, CHALLENGE, SIM_UAM_SECRET)).toBe(chap);
      expect(deviceDecodePapTip(pap, CHALLENGE, SIM_UAM_SECRET)).toBe(pw);
      expect(deviceDecodePapUpstream(pap, CHALLENGE, SIM_UAM_SECRET)).toBe(pw);
    }
  });
});

for (const t of TARGETS) {
  const tag = `[${t.adapterKey}]`;

  describe(`hand-off ${tag}`, () => {
    it(`SIM-09 ${tag} PAP XOR encoding matches the reference vectors and decodes on the device`, async () => {
      for (const [pw, [pap]] of Object.entries(VECTORS)) {
        expect(encodeUamPapPassword(pw, CHALLENGE, SIM_UAM_SECRET)).toBe(pap);
        const ctx = await validContext(t);
        const h = t.adapter.authorizeSession(ctx, credential(t, { password: pw }), {
          uamSecret: SIM_UAM_SECRET,
        });
        if ('unsupported' in h) throw new Error(h.reason);
        expect(h).toMatchObject({ strategy: 'browser-form', state: 'pending' });
        const logon = parseDeviceLogon(h.browser?.url ?? '');
        expect(logon).toMatchObject({
          host: '10.1.0.1',
          port: '3990',
          path: '/logon',
          username: 'pc-sim-0001',
          passwordHex: pap,
          response: null,
        });
        // Both device decoders recover the cleartext (T: chunk loop, U/Coova: MIN(len,16)).
        expect(deviceDecodePapTip(logon.passwordHex ?? '', CHALLENGE, SIM_UAM_SECRET)).toBe(pw);
        expect(deviceDecodePapUpstream(logon.passwordHex ?? '', CHALLENGE, SIM_UAM_SECRET)).toBe(
          pw,
        );
        // Neither the cleartext nor the UAM secret ever appears in the hand-off.
        const text = JSON.stringify(h);
        expect(text).not.toContain(SIM_UAM_SECRET);
        expect(text).not.toContain(`password=${pw}&`);
      }
    });

    it(`SIM-09 ${tag} hand-off refuses > 16-byte passwords, missing secret, unbound credential`, async () => {
      const ctx = await validContext(t);
      const cases = [
        t.adapter.authorizeSession(ctx, credential(t, { password: 'seventeen-bytes-x' }), {
          uamSecret: SIM_UAM_SECRET,
        }),
        t.adapter.authorizeSession(ctx, credential(t), { uamSecret: null }),
        t.adapter.authorizeSession(ctx, credential(t)),
        t.adapter.authorizeSession(ctx, credential(t, { boundNasId: 'sim-nas-other' }), {
          uamSecret: SIM_UAM_SECRET,
        }),
        t.adapter.authorizeSession(ctx, credential(t, { boundClientMac: 'aa:bb:cc:dd:ee:99' }), {
          uamSecret: SIM_UAM_SECRET,
        }),
        t.adapter.authorizeSession(
          ctx,
          credential(t, { expiresAt: new Date(ctx.receivedAt.getTime() - 1) }),
          { uamSecret: SIM_UAM_SECRET },
        ),
      ];
      for (const c of cases) expect(c).toMatchObject({ unsupported: true });
    });

    it(`SIM-09 ${tag} CHAP: ECLOUD emits PAP only; CHAP reference checked, no response= sent`, async () => {
      // CP §7.4 makes CHAP optional for CoovaChilli; the L2 hand-off implements PAP only, so the
      // CHAP half of SIM-09 is a reference-vector check of the simulator, not of ECLOUD code.
      const h = t.adapter.authorizeSession(await validContext(t), credential(t), {
        uamSecret: SIM_UAM_SECRET,
      });
      if ('unsupported' in h) throw new Error(h.reason);
      expect(Object.keys(h.browser?.fields ?? {}).sort()).toEqual(
        ['password', 'username', 'userurl'].sort(),
      );
      const [, chap] = VECTORS['pc-pass-01'] ?? ['', ''];
      expect(referenceChapResponse('pc-pass-01', CHALLENGE, SIM_UAM_SECRET)).toBe(chap);
    });

    it(`SIM-15 ${tag} VLAN: explicit unenforceable entry per degradation mode; strict → reject`, async () => {
      const decl = getAdapter(t.adapterKey).capabilities().fields.vlan_id;
      expect(decl.status).not.toBe('VERIFIED_SUPPORTED');
      for (const mode of ['fallback_ecloud_side', 'allow_and_flag', 'strict_reject'] as const) {
        const p = await plan(t, { vlan_id: 100 }, mode);
        const u = p.enforcement.unenforceable.filter((x) => x.field === 'vlan_id');
        expect(u, mode).toHaveLength(1);
        expect(u[0]?.reason, mode).toBe(
          decl.status === 'REQUIRES_DEVICE_TEST' ? 'requires_device_test' : 'unsupported',
        );
        expect(p.enforcement.degradation).toBe(mode);
        expect(p.enforcement.decision).toBe(mode === 'strict_reject' ? 'reject' : 'accept');
        if (mode === 'strict_reject')
          expect(p.enforcement.reasonCode).toBe('unenforceable:vlan_id');
        // No VLAN attribute reaches the device.
        expect(p.replyAttributes.filter((a) => /VLAN|Tunnel/i.test(a.name))).toEqual([]);
        expect(p.gatewaySuggestion).toBe(expectedSuggestion(t, ['vlan_id']));
      }
      const critical = await plan(t, { vlan_id: 100 }, 'fallback_ecloud_side', ['vlan_id']);
      expect(critical.enforcement.decision).toBe('reject');
    });

    it(`SIM-15 ${tag} burst is unenforceable on every UAM adapter`, async () => {
      const p = await plan(t, {
        download_rate_kbps: 10000,
        burst_download_kbps: 20000,
        burst_duration_s: 30,
      });
      const fields = p.enforcement.unenforceable.map((u) => u.field);
      expect(fields).toEqual(expect.arrayContaining(['burst_download_kbps', 'burst_duration_s']));
      const strict = await plan(
        t,
        { download_rate_kbps: 10000, burst_download_kbps: 20000, burst_duration_s: 30 },
        'strict_reject',
      );
      expect(strict.enforcement.decision).toBe('reject');
      expect(p.gatewaySuggestion).toBe(
        expectedSuggestion(t, ['burst_download_kbps', 'burst_duration_s']),
      );
    });

    it(`SIM-15 ${tag} quota > 4 GiB: TIP clamps with an explicit flag, Coova splits Gigawords`, async () => {
      const total = 6n * 1024n ** 3n; // 6 GiB
      const p = await plan(t, { quota_total_bytes: total });
      const caps = getAdapter(t.adapterKey).capabilities();
      const totalAttr = caps.quotaAttributes.total ?? '';
      const emitted = p.replyAttributes.find((a) => a.name === totalAttr);
      if (caps.octetWidth === 32) {
        expect(emitted?.value).toBe(RADIUS_UINT32_MAX);
        expect(p.enforcement.unenforceable).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: 'quota_total_bytes', reason: 'overflow_clamped' }),
          ]),
        );
        expect(p.gatewaySuggestion).toBe(expectedSuggestion(t, ['quota_total_bytes']));
      } else {
        const giga = p.replyAttributes.find((a) => a.name === caps.quotaAttributes.totalGigawords);
        expect(BigInt(giga?.value ?? 0) * 2n ** 32n + BigInt(emitted?.value ?? 0)).toBe(total);
        expect(p.enforcement.unenforceable.filter((u) => u.field === 'quota_total_bytes')).toEqual(
          [],
        );
        expect(p.gatewaySuggestion).toBeNull();
      }
    });

    it(`SIM-16 ${tag} Disconnect without the mandatory attribute → Unsupported; status stays RDT`, () => {
      const engine = getAdapter(t.adapterKey);
      const disc = engine.capabilities().disconnect;
      expect(disc.status).toBe('REQUIRES_DEVICE_TEST');
      expect(['LAB_VALIDATED', 'SIMULATOR_TESTED', 'PRODUCTION_VALIDATED']).not.toContain(
        disc.evidenceLevel,
      );
      const mandatory = t.adapterKey === 'coovachilli-uam' ? 'User-Name' : 'Calling-Station-Id';
      const full = {
        sessionId: 's-sim',
        userName: 'pc-sim-0001',
        acctSessionId: '5f3c2a1b0d9e8f70',
        callingStationId: 'AA-BB-CC-DD-EE-01',
        nasIdentifier: t.nas.identifier,
      };
      const lacking =
        t.adapterKey === 'coovachilli-uam'
          ? { ...full, userName: null }
          : { ...full, callingStationId: null };
      const r = t.adapter.revokeSession(lacking);
      expect(r).toMatchObject({ unsupported: true });
      expect('reason' in r ? r.reason : '').toContain(mandatory);
      const ok = t.adapter.revokeSession(full);
      expect(ok).toMatchObject({ kind: 'disconnect', status: 'REQUIRES_DEVICE_TEST' });
      expect('attributes' in ok ? ok.attributes.map((a) => a.name) : []).toContain(mandatory);
    });
  });
}

it('SIM-09 hand-off never runs for a redirect that failed validation (sanity)', async () => {
  const t = TARGETS[0];
  if (!t) throw new Error('no target');
  const r = redirect(t, { uamSecret: 'attacker-guess-fake' });
  await expect(validContext(t, r.url)).rejects.toThrow(/bad_signature/);
});
