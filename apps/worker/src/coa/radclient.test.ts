import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatAttributes,
  parseRadclientOutput,
  radclientArgs,
  sendDynamicAuthorization,
  type RadclientRunner,
} from './radclient.js';

const exec = (stdout: string, exitCode: number | null = 0, stderr = '', killed = false) => ({
  stdout,
  stderr,
  exitCode,
  killed,
});

describe('radclient attribute file', () => {
  it('quotes strings, escapes quotes, keeps numbers and 0x octets bare', () => {
    expect(
      formatAttributes([
        { name: 'User-Name', value: 'pc-"x"\\y' },
        { name: 'Event-Timestamp', value: 1767225600 },
        { name: 'Message-Authenticator', value: '0x00' },
      ]),
    ).toBe(
      'User-Name = "pc-\\"x\\"\\\\y"\nEvent-Timestamp = 1767225600\nMessage-Authenticator = 0x00\n',
    );
  });
  it('passes the secret file with -S and brackets IPv6 hosts', () => {
    expect(
      radclientArgs('/tmp/s', {
        host: '192.0.2.10',
        port: 3799,
        command: 'disconnect',
        timeoutS: 2,
        retries: 3,
      }),
    ).toEqual(['-x', '-r', '3', '-t', '2', '-S', '/tmp/s', '192.0.2.10:3799', 'disconnect']);
    expect(
      radclientArgs('/tmp/s', {
        host: '2001:db8::1',
        port: 3799,
        command: 'coa',
        timeoutS: 2,
        retries: 0,
      }).slice(-2),
    ).toEqual(['[2001:db8::1]:3799', 'coa']);
  });
});

describe('parseRadclientOutput', () => {
  it('ACK only with a literal "Received Disconnect-ACK" and exit 0', () => {
    expect(
      parseRadclientOutput(
        exec('Sent Disconnect-Request Id 1\nReceived Disconnect-ACK Id 1 from 192.0.2.10:3799'),
      ),
    ).toEqual({ result: 'ack' });
    expect(parseRadclientOutput(exec('Received CoA-ACK Id 9'))).toEqual({ result: 'ack' });
    expect(parseRadclientOutput(exec('Received Disconnect-ACK Id 1', 1)).result).toBe('error');
    expect(parseRadclientOutput(exec('', 0)).result).toBe('error');
  });
  it('NAK with Error-Cause', () => {
    expect(
      parseRadclientOutput(
        exec('Received Disconnect-NAK Id 1\n\tError-Cause = Session-Context-Not-Found\n', 1),
      ),
    ).toEqual({ result: 'nak', errorCause: 'Session-Context-Not-Found' });
    expect(parseRadclientOutput(exec('Received CoA-NAK Id 1', 1))).toEqual({
      result: 'nak',
      errorCause: null,
    });
  });
  it('timeout on "No reply from server" or when killed', () => {
    expect(parseRadclientOutput(exec('', 1, '(0) No reply from server for ID 1 socket 3'))).toEqual(
      { result: 'timeout' },
    );
    expect(parseRadclientOutput(exec('', null, '', true))).toEqual({ result: 'timeout' });
  });
  it('anything else is an error with the first output line', () => {
    expect(parseRadclientOutput(exec('', null, 'spawn radclient ENOENT'))).toEqual({
      result: 'error',
      message: 'spawn radclient ENOENT',
    });
  });
});

describe('sendDynamicAuthorization', () => {
  it('writes the secret to a 0600 file passed with -S, never in argv, and deletes it', async () => {
    let seenFile = '';
    let seenArgs: readonly string[] = [];
    let seenStdin = '';
    const runner: RadclientRunner = (path, args, stdin) => {
      expect(path).toBe('/usr/bin/radclient');
      seenArgs = args;
      seenStdin = stdin;
      seenFile = args[args.indexOf('-S') + 1] ?? '';
      expect(readFileSync(seenFile, 'utf8')).toBe('s3cr3t-placeholder\n');
      expect(statSync(seenFile).mode & 0o777).toBe(0o600);
      return Promise.resolve(exec('Received Disconnect-ACK Id 3'));
    };
    const out = await sendDynamicAuthorization({
      radclientPath: '/usr/bin/radclient',
      host: '192.0.2.10',
      port: 3799,
      command: 'disconnect',
      secret: 's3cr3t-placeholder',
      attributes: [{ name: 'User-Name', value: 'pc-alice' }],
      timeoutS: 2,
      retries: 3,
      runner,
    });
    expect(out).toEqual({ result: 'ack' });
    expect(seenArgs.join(' ')).not.toContain('s3cr3t');
    expect(seenStdin).toBe('User-Name = "pc-alice"\n');
    expect(existsSync(seenFile)).toBe(false);
  });
  it('deletes the secret file when the runner throws', async () => {
    let seenFile = '';
    const runner: RadclientRunner = (_p, args) => {
      seenFile = args[args.indexOf('-S') + 1] ?? '';
      return Promise.reject(new Error('boom'));
    };
    await expect(
      sendDynamicAuthorization({
        radclientPath: 'radclient',
        host: '192.0.2.10',
        port: 3799,
        command: 'coa',
        secret: 'x',
        attributes: [],
        timeoutS: 1,
        retries: 1,
        runner,
      }),
    ).rejects.toThrow('boom');
    expect(seenFile).not.toBe('');
    expect(existsSync(seenFile)).toBe(false);
  });
});
