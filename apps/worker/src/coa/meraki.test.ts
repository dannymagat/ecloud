/**
 * Cycle E (D-044): Meraki Disconnect through the existing CoA/Disconnect dispatcher.
 * Meraki doc "CoA Disconnect for Splash Sign-on": Disconnect only, to the organization's
 * dashboard host on UDP 3799, Acct-Session-Id + Event-Timestamp. REQUIRES_DEVICE_TEST: these
 * tests only prove what ECLOUD sends; nothing reaches a real Meraki service (fake runner).
 */
import { describe, expect, it, vi } from 'vitest';
import type { RadclientRunner } from './radclient.js';
import {
  MERAKI_DAS_PORT,
  dispatchTarget,
  performDispatch,
  type ActionContext,
  type PerformDeps,
} from './dispatcher.js';

const NOW = new Date('2026-01-01T00:00:00Z');

function action(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    id: '0199b0a4-0000-7000-8000-0000000000e1',
    organization_id: '0199b0a4-0000-7000-8000-0000000000e2',
    action: 'disconnect',
    status: 'pending',
    payload: {},
    session_id: '0199b0a4-0000-7000-8000-0000000000e3',
    site_id: '0199b0a4-0000-7000-8000-0000000000e4',
    session_status: 'active',
    username_raw: 'pc-0123456789abcdef',
    acct_session_id: 'C0FFEE0001',
    calling_station_id: 'F4-5C-89-9B-17-67',
    framed_ip: '10.0.0.13',
    nas_ip: null,
    nas_identifier: 'meraki-lobby',
    coa_port: null,
    secret_ref: 'env:TEST_NAS_SECRET',
    adapter_key: 'meraki-splash',
    das_host: 'n165.meraki.com',
    ...overrides,
  };
}

function deps(runner: RadclientRunner, overrides: Partial<PerformDeps> = {}): PerformDeps {
  return {
    coaEnabled: true,
    merakiCloudRadiusEnabled: true,
    radclientPath: 'radclient',
    timeoutS: 2,
    retries: 3,
    defaultCoaPort: 3799,
    resolveSecret: (ref) =>
      Promise.resolve(ref === 'env:TEST_NAS_SECRET' ? 'placeholder-secret' : undefined),
    runner,
    ...overrides,
  };
}

const reply = (stdout: string, exitCode = 0): RadclientRunner =>
  vi.fn(() => Promise.resolve({ stdout, stderr: '', exitCode, killed: false }));

describe('Meraki Disconnect (Cycle E)', () => {
  it('targets the dashboard host on UDP 3799, never a packet source address', () => {
    expect(
      dispatchTarget(action(), { defaultCoaPort: 1700, merakiCloudRadiusEnabled: true }),
    ).toEqual({ host: 'n165.meraki.com', port: MERAKI_DAS_PORT });
    expect(
      dispatchTarget(action({ das_host: null }), {
        defaultCoaPort: 3799,
        merakiCloudRadiusEnabled: true,
      }),
    ).toMatchObject({ unsupported: expect.stringContaining('das_host') as unknown });
    expect(
      dispatchTarget(action({ das_host: 'evil.example' }), {
        defaultCoaPort: 3799,
        merakiCloudRadiusEnabled: true,
      }),
    ).toHaveProperty('unsupported');
    expect(dispatchTarget(action(), { defaultCoaPort: 3799 })).toMatchObject({
      unsupported: expect.stringContaining('meraki_cloud_radius_disabled') as unknown,
    });
    // other adapters keep nas_ip:coa_port
    expect(
      dispatchTarget(
        action({ adapter_key: 'coovachilli-uam', nas_ip: '10.1.1.1', coa_port: 3800 }),
        { defaultCoaPort: 3799 },
      ),
    ).toEqual({ host: '10.1.1.1', port: 3800 });
  });

  it('sends Acct-Session-Id + Event-Timestamp (+ Message-Authenticator) only', async () => {
    const runner = reply('Sent Disconnect-Request Id 1\nReceived Disconnect-ACK Id 1');
    const d = await performDispatch(action(), deps(runner), { attempt: 1, maxAttempts: 3 }, NOW);
    expect(d).toMatchObject({ kind: 'final', status: 'ack', closeSession: false });
    const [, args, stdin] = vi.mocked(runner).mock.calls[0] ?? [];
    expect(args).toContain('n165.meraki.com:3799');
    expect(args).toContain('disconnect');
    expect(stdin).toBe(
      'Acct-Session-Id = "C0FFEE0001"\nEvent-Timestamp = 1767225600\nMessage-Authenticator = 0x00\n',
    );
  });

  it('flag OFF: recorded unsupported, radclient never runs', async () => {
    const runner = reply('Received Disconnect-ACK');
    const d = await performDispatch(
      action(),
      deps(runner, { merakiCloudRadiusEnabled: false }),
      { attempt: 1, maxAttempts: 3 },
      NOW,
    );
    expect(d).toMatchObject({ kind: 'final', status: 'unsupported' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('CoA change is unsupported (Meraki documents Disconnect only)', async () => {
    const runner = reply('Received CoA-ACK');
    const d = await performDispatch(
      action({ action: 'coa_update', payload: { plan: { adapter: 'meraki-splash' } } }),
      deps(runner),
      { attempt: 1, maxAttempts: 3 },
      NOW,
    );
    expect(d).toMatchObject({ kind: 'final', status: 'unsupported' });
    expect(runner).not.toHaveBeenCalled();
  });
});
