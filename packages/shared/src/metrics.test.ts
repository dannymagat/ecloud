import { describe, expect, it } from 'vitest';
import { MetricsRegistry, PROMETHEUS_CONTENT_TYPE, registerProcessMetrics } from './metrics.js';

describe('MetricsRegistry', () => {
  it('renders counters with HELP/TYPE and escaped labels', async () => {
    const r = new MetricsRegistry();
    const c = r.counter({ name: 'x_total', help: 'X\nhelp', labelNames: ['route', 'status'] });
    c.inc({ route: '/a', status: '200' });
    c.inc({ route: '/a', status: '200' }, 2);
    c.inc({ route: 'q"\\\n', status: '500' });
    const text = await r.render();
    expect(text).toContain('# HELP x_total X\\nhelp');
    expect(text).toContain('# TYPE x_total counter');
    expect(text).toContain('x_total{route="/a",status="200"} 3');
    expect(text).toContain('x_total{route="q\\"\\\\\\n",status="500"} 1');
    expect(c.get({ route: '/a', status: '200' })).toBe(3);
    expect(text.endsWith('\n')).toBe(true);
    expect(PROMETHEUS_CONTENT_TYPE).toContain('version=0.0.4');
  });

  it('rejects unknown labels, bad names, duplicates and negative increments', () => {
    const r = new MetricsRegistry();
    const c = r.counter({ name: 'a_total', help: 'a', labelNames: ['k'] });
    expect(() => c.inc({ other: 'v' })).toThrow(/unknown label/);
    expect(() => c.inc({ k: 'v' }, -1)).toThrow();
    expect(() => r.counter({ name: 'a_total', help: 'dup' })).toThrow(/already exists/);
    expect(() => r.counter({ name: 'bad-name', help: 'x' })).toThrow(/invalid metric name/);
    expect(() => r.histogram({ name: 'h', help: 'h', labelNames: ['le'] })).toThrow(/label/);
  });

  it('renders cumulative histogram buckets, sum and count', async () => {
    const r = new MetricsRegistry();
    const h = r.histogram({
      name: 'lat_seconds',
      help: 'l',
      labelNames: ['op'],
      buckets: [0.1, 1],
    });
    h.observe({ op: 'a' }, 0.05);
    h.observe({ op: 'a' }, 0.5);
    h.observe({ op: 'a' }, 3);
    const text = await r.render();
    expect(text).toContain('lat_seconds_bucket{op="a",le="0.1"} 1');
    expect(text).toContain('lat_seconds_bucket{op="a",le="1"} 2');
    expect(text).toContain('lat_seconds_bucket{op="a",le="+Inf"} 3');
    expect(text).toContain('lat_seconds_sum{op="a"} 3.55');
    expect(text).toContain('lat_seconds_count{op="a"} 3');
    const stop = h.startTimer({ op: 'b' });
    expect(stop()).toBeGreaterThanOrEqual(0);
    expect(h.count({ op: 'b' })).toBe(1);
  });

  it('gauges support set/inc/dec and scrape-time collectors (a failing collector renders nothing)', async () => {
    const r = new MetricsRegistry();
    const g = r.gauge({ name: 'g', help: 'g', labelNames: ['q'] });
    g.set({ q: 'a' }, 5);
    g.inc({ q: 'a' });
    g.dec({ q: 'a' }, 2);
    expect(g.get({ q: 'a' })).toBe(4);
    r.gauge({
      name: 'depth',
      help: 'd',
      labelNames: ['queue', 'state'],
      collect: () => Promise.resolve([{ labels: { queue: 'x', state: 'wait' }, value: 7 }]),
    });
    r.gauge({ name: 'broken', help: 'b', collect: () => Promise.reject(new Error('down')) });
    const text = await r.render();
    expect(text).toContain('g{q="a"} 4');
    expect(text).toContain('depth{queue="x",state="wait"} 7');
    expect(text).toContain('# TYPE broken gauge');
    expect(text).not.toMatch(/^broken /m);
  });

  it('registers process gauges', async () => {
    const r = new MetricsRegistry();
    const stop = registerProcessMetrics(r, 'ecloud_test');
    const text = await r.render();
    stop();
    expect(text).toMatch(/^ecloud_test_process_resident_memory_bytes \d+/m);
    expect(text).toMatch(/^ecloud_test_event_loop_lag_seconds /m);
  });
});
