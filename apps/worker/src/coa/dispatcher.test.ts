import { describe, expect, it, vi } from 'vitest';
import type { RadclientRunner } from './radclient.js';
import {
  SKIPPED_DISABLED,
  performDispatch,
  withRequestHygiene,
  type ActionContext,
  type PerformDeps,
} from './dispatcher.js';

const NOW = new Date('2026-01-01T00:00:00Z');

function action(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    id: '0199b0a4-0000-7000-8000-000000000001',
    organization_id: '0199b0a4-0000-7000-8000-000000000002',
    action: 'disconnect',
    status: 'pending',
    payload: {},
    session_id: '0199b0a4-0000-7000-8000-000000000003',
    site_id: '0199b0a4-0000-7000-8000-000000000004',
    session_status: 'active',
    username_raw: 'pc-alice',
    acct_session_id: '5f3e1a2b00000001',
    calling_station_id: 'AA-BB-CC-DD-EE-FF',
    framed_ip: '192.0.2.100',
    nas_ip: '192.0.2.10',
    nas_identifier: 'nas-1',
    coa_port: null,
    secret_ref: 'env:TEST_NAS_SECRET',
    adapter_type_key: 'coovachilli-uam',
    ...overrides,
  };
}

function deps(runner: RadclientRunner, overrides: Partial<PerformDeps> = {}): PerformDeps {
  return {
    coaEnabled: true,
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

describe('performDispatch', () => {
  it('disabled: records skipped_disabled and never runs radclient', async () => {
    const runner = reply('Received Disconnect-ACK');
    const d = await performDispatch(
      action(),
      deps(runner, { coaEnabled: false }),
      { attempt: 1, maxAttempts: 3 },
      NOW,
    );
    expect(d).toMatchObject({
      kind: 'final',
      status: 'unsupported',
      error: SKIPPED_DISABLED,
      closeSession: false,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('ACK: sends to nas_ip:3799 with adapter identity + hygiene attributes; chilli sends its own Stop', async () => {
    const runner = reply('Sent Disconnect-Request Id 1\nReceived Disconnect-ACK Id 1');
    const onSend = vi.fn(() => Promise.resolve());
    const d = await performDispatch(
      action(),
      deps(runner, { onSend }),
      { attempt: 1, maxAttempts: 3 },
      NOW,
    );
    expect(d).toMatchObject({ kind: 'final', status: 'ack', error: null, closeSession: false });
    expect(onSend).toHaveBeenCalledOnce();
    const [, args, stdin] = vi.mocked(runner).mock.calls[0] ?? [];
    expect(args).toContain('192.0.2.10:3799');
    expect(args).toContain('disconnect');
    expect(stdin).toBe(
      'User-Name = "pc-alice"\nAcct-Session-Id = "5f3e1a2b00000001"\nEvent-Timestamp = 1767225600\nMessage-Authenticator = 0x00\n',
    );
  });

  it('ACK on TIP uspot (no Acct-Stop after kick) closes the ECLOUD session', async () => {
    const d = await performDispatch(
      action({ adapter_type_key: 'openwifi-uspot-uam', coa_port: 3800 }),
      deps(reply('Received Disconnect-ACK Id 2')),
      { attempt: 1, maxAttempts: 3 },
      NOW,
    );
    expect(d).toMatchObject({ kind: 'final', status: 'ack', closeSession: true });
  });

  it('NAK: final, with Error-Cause, no session change', async () => {
    const d = await performDispatch(
      action(),
      deps(reply('Received Disconnect-NAK Id 1\n  Error-Cause = Session-Context-Not-Found', 1)),
      { attempt: 1, maxAttempts: 3 },
      NOW,
    );
    expect(d).toMatchObject({
      kind: 'final',
      status: 'nak',
      error: 'Error-Cause=Session-Context-Not-Found',
      closeSession: false,
    });
  });

  it('timeout: retry before the last attempt, final timeout on it', async () => {
    const runner: RadclientRunner = () =>
      Promise.resolve({
        stdout: '',
        stderr: '(0) No reply from server for ID 1',
        exitCode: 1,
        killed: false,
      });
    expect(
      await performDispatch(action(), deps(runner), { attempt: 1, maxAttempts: 3 }, NOW),
    ).toMatchObject({ kind: 'retry' });
    expect(
      await performDispatch(action(), deps(runner), { attempt: 3, maxAttempts: 3 }, NOW),
    ).toMatchObject({
      kind: 'final',
      status: 'timeout',
      closeSession: false,
    });
  });

  it('unsupported: adapter without Disconnect, missing identity, missing secret, missing CoA plan', async () => {
    const runner = reply('Received Disconnect-ACK');
    const one = { attempt: 1, maxAttempts: 3 };
    expect(
      await performDispatch(
        action({ adapter_type_key: 'openwifi-config' }),
        deps(runner),
        one,
        NOW,
      ),
    ).toMatchObject({ status: 'unsupported' });
    expect(
      await performDispatch(action({ username_raw: null }), deps(runner), one, NOW),
    ).toMatchObject({
      status: 'unsupported',
      error: expect.stringContaining('User-Name') as unknown,
    });
    expect(
      await performDispatch(action({ secret_ref: 'vault:x' }), deps(runner), one, NOW),
    ).toMatchObject({ status: 'unsupported' });
    expect(
      await performDispatch(action({ action: 'coa_update' }), deps(runner), one, NOW),
    ).toMatchObject({
      status: 'unsupported',
      error: 'payload.plan (EnforcementPlan) missing',
    });
    expect(
      await performDispatch(action({ adapter_type_key: 'acme' }), deps(runner), one, NOW),
    ).toMatchObject({ status: 'unsupported' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('CoA: sends only changeable attributes from the plan', async () => {
    const runner = reply('Received CoA-ACK Id 4');
    const plan = {
      adapter: 'coovachilli-uam',
      radiusReplyAttributes: [
        { name: 'Session-Timeout', value: 900 },
        { name: 'Class', value: 'ai:x' },
      ],
    };
    const d = await performDispatch(
      action({ action: 'coa_update', payload: { plan } }),
      deps(runner),
      { attempt: 1, maxAttempts: 3 },
      NOW,
    );
    expect(d).toMatchObject({ kind: 'final', status: 'ack', closeSession: false });
    const [, args, stdin] = vi.mocked(runner).mock.calls[0] ?? [];
    expect(args).toContain('coa');
    expect(stdin).toContain('Session-Timeout = 900');
    expect(stdin).not.toContain('Class');
  });
});

describe('withRequestHygiene', () => {
  it('does not duplicate attributes already present', () => {
    const out = withRequestHygiene([{ name: 'Event-Timestamp', value: 1 }], NOW);
    expect(out.filter((a) => a.name === 'Event-Timestamp')).toHaveLength(1);
    expect(out.map((a) => a.name)).toContain('Message-Authenticator');
  });
});
