import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function memorySink(): { lines: string[]; write(chunk: string): void } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
    },
  };
}

describe('createLogger', () => {
  it('writes JSON lines with name and level label', () => {
    const sink = memorySink();
    const log = createLogger({ name: 'test', level: 'debug', destination: sink });
    log.info({ requestId: 'r1' }, 'hello');
    expect(sink.lines).toHaveLength(1);
    const parsed = JSON.parse(sink.lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.name).toBe('test');
    expect(parsed.msg).toBe('hello');
    expect(parsed.requestId).toBe('r1');
    expect(typeof parsed.time).toBe('string');
  });

  it('redacts password, secret, token, authorization and cookie at several depths', () => {
    const sink = memorySink();
    const log = createLogger({ name: 'test', destination: sink });
    log.info(
      {
        password: 'p1',
        secret: 's1',
        token: 't1',
        authorization: 'Bearer a1',
        cookie: 'sid=c1',
        user: { password: 'p2', nested: { token: 't2', deeper: { secret: 's3' } } },
        req: { headers: { authorization: 'Bearer a2', cookie: 'sid=c2', host: 'ok' } },
      },
      'login',
    );
    const line = sink.lines[0] ?? '';
    for (const leaked of ['p1', 's1', 't1', 'a1', 'c1', 'p2', 't2', 's3', 'a2', 'c2']) {
      expect(line).not.toContain(`"${leaked}"`);
      expect(line).not.toContain(`Bearer ${leaked}`);
      expect(line).not.toContain(`sid=${leaked}`);
    }
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('"host":"ok"');
  });

  it('respects the level', () => {
    const sink = memorySink();
    const log = createLogger({ name: 'test', level: 'warn', destination: sink });
    log.info('ignored');
    log.warn('kept');
    expect(sink.lines).toHaveLength(1);
  });
});
