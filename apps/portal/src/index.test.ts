import { createLogger, loadConfig, type AppConfig } from '@ecloud/shared';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { PACKAGE_NAME, createServer, main } from './index.js';

const logger = createLogger({ name: 'portal-test', level: 'silent' });

/** Dev config with an ephemeral port (the schema forbids 0, so it is patched after parsing). */
function testConfig(): AppConfig {
  const base = loadConfig({ NODE_ENV: 'test' });
  return { ...base, ports: { ...base.ports, portal: 0 } };
}

function portOf(running: Awaited<ReturnType<typeof main>>): number {
  return (running.server.address() as AddressInfo).port;
}

describe('@ecloud/portal', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@ecloud/portal');
  });

  it('GET /healthz returns status ok', async () => {
    const res = await request(createServer()).get('/healthz');
    expect(res.status).toBe(200);
    const body: unknown = res.body;
    expect(body).toEqual({ status: 'ok' });
  });

  it('serves /healthz from main() and shutdown() closes the listener', async () => {
    const running = await main({ config: testConfig(), logger, handleSignals: false });
    const res = await fetch(`http://127.0.0.1:${portOf(running)}/healthz`);
    expect(res.status).toBe(200);
    await running.shutdown();
    expect(running.server.listening).toBe(false);
    // Idempotent: a second call resolves without throwing.
    await running.shutdown();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('%s drains the server and exits 0', async (signal) => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const running = await main({
      config: testConfig(),
      logger,
      signalSource: signals,
      exit,
    });
    expect(running.server.listening).toBe(true);
    signals.emit(signal);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(running.server.listening).toBe(false);
  });
});
