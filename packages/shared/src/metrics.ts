/**
 * Minimal Prometheus text-format (exposition format 0.0.4) metrics registry for the api,
 * worker and portal `/metrics` endpoints (Phase 10, DEPLOYMENT_ARCHITECTURE.md §6).
 *
 * Deliberately dependency-free: counters, gauges (optionally computed at scrape time) and
 * histograms with fixed buckets are all the pilot needs. Label values are bounded by the
 * callers (route templates, never raw paths; outcomes from closed enums), so cardinality stays
 * small. Nothing here may carry secrets, usernames, MACs or IPs.
 */

export type Labels = Readonly<Record<string, string>>;

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Default latency buckets (seconds), dense around the 100 ms authorize target. */
export const DEFAULT_LATENCY_BUCKETS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5, 10,
]);

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function labelKey(labelNames: readonly string[], labels: Labels): string {
  for (const key of Object.keys(labels)) {
    if (!labelNames.includes(key)) throw new Error(`unknown label "${key}"`);
  }
  return labelNames.map((name) => labels[name] ?? '').join('\u0000');
}

function renderLabels(pairs: ReadonlyArray<readonly [string, string]>): string {
  if (pairs.length === 0) return '';
  return `{${pairs.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

function pairsOf(labelNames: readonly string[], key: string): Array<[string, string]> {
  if (labelNames.length === 0) return [];
  const values = key.split('\u0000');
  return labelNames.map((name, i) => [name, values[i] ?? '']);
}

interface MetricOptions {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

abstract class Metric {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  abstract readonly type: 'counter' | 'gauge' | 'histogram';

  constructor(options: MetricOptions) {
    if (!NAME_RE.test(options.name)) throw new Error(`invalid metric name "${options.name}"`);
    for (const label of options.labelNames ?? []) {
      if (!LABEL_RE.test(label) || label === 'le') throw new Error(`invalid label "${label}"`);
    }
    this.name = options.name;
    this.help = options.help;
    this.labelNames = Object.freeze([...(options.labelNames ?? [])]);
  }

  protected header(): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
  }

  abstract render(): Promise<string[]>;
}

export class Counter extends Metric {
  readonly type = 'counter' as const;
  private readonly values = new Map<string, number>();

  inc(labels: Labels = {}, amount = 1): void {
    if (!(amount >= 0) || !Number.isFinite(amount)) {
      throw new Error('counter increment must be finite and >= 0');
    }
    const key = labelKey(this.labelNames, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(this.labelNames, labels)) ?? 0;
  }

  render(): Promise<string[]> {
    const lines = this.header();
    for (const [key, value] of this.values) {
      lines.push(
        `${this.name}${renderLabels(pairsOf(this.labelNames, key))} ${formatNumber(value)}`,
      );
    }
    return Promise.resolve(lines);
  }
}

export interface GaugeOptions extends MetricOptions {
  /**
   * Computed at scrape time (e.g. queue depths). Returned samples replace the stored ones for
   * that scrape. A throwing collector renders no samples (the scrape itself never fails).
   */
  collect?: () => Promise<ReadonlyArray<{ labels?: Labels; value: number }>>;
}

export class Gauge extends Metric {
  readonly type = 'gauge' as const;
  private readonly values = new Map<string, number>();
  private readonly collector: GaugeOptions['collect'];

  constructor(options: GaugeOptions) {
    super(options);
    this.collector = options.collect;
  }

  set(labels: Labels, value: number): void {
    this.values.set(labelKey(this.labelNames, labels), value);
  }

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(this.labelNames, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  dec(labels: Labels = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(this.labelNames, labels)) ?? 0;
  }

  async render(): Promise<string[]> {
    const lines = this.header();
    let samples: Array<[string, number]> = [...this.values];
    if (this.collector !== undefined) {
      try {
        const collected = await this.collector();
        samples = collected.map((s) => [labelKey(this.labelNames, s.labels ?? {}), s.value]);
      } catch {
        samples = [];
      }
    }
    for (const [key, value] of samples) {
      lines.push(
        `${this.name}${renderLabels(pairsOf(this.labelNames, key))} ${formatNumber(value)}`,
      );
    }
    return lines;
  }
}

export interface HistogramOptions extends MetricOptions {
  buckets?: readonly number[];
}

interface HistogramSeries {
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram extends Metric {
  readonly type = 'histogram' as const;
  readonly buckets: readonly number[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(options: HistogramOptions) {
    super(options);
    const buckets = [...(options.buckets ?? DEFAULT_LATENCY_BUCKETS)].sort((a, b) => a - b);
    if (buckets.length === 0 || buckets.some((b) => !Number.isFinite(b))) {
      throw new Error('histogram buckets must be finite numbers');
    }
    this.buckets = Object.freeze(buckets);
  }

  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return;
    const key = labelKey(this.labelNames, labels);
    let s = this.series.get(key);
    if (s === undefined) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= (this.buckets[i] ?? Infinity)) s.counts[i] = (s.counts[i] ?? 0) + 1;
    }
    s.sum += value;
    s.count += 1;
  }

  /** Starts a timer; the returned function observes the elapsed seconds. */
  startTimer(labels: Labels = {}): (extra?: Labels) => number {
    const start = process.hrtime.bigint();
    return (extra: Labels = {}) => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.observe({ ...labels, ...extra }, seconds);
      return seconds;
    };
  }

  count(labels: Labels = {}): number {
    return this.series.get(labelKey(this.labelNames, labels))?.count ?? 0;
  }

  render(): Promise<string[]> {
    const lines = this.header();
    for (const [key, s] of this.series) {
      const pairs = pairsOf(this.labelNames, key);
      this.buckets.forEach((le, i) => {
        lines.push(
          `${this.name}_bucket${renderLabels([...pairs, ['le', formatNumber(le)]])} ${String(s.counts[i] ?? 0)}`,
        );
      });
      lines.push(
        `${this.name}_bucket${renderLabels([...pairs, ['le', '+Inf']])} ${String(s.count)}`,
      );
      lines.push(`${this.name}_sum${renderLabels(pairs)} ${formatNumber(s.sum)}`);
      lines.push(`${this.name}_count${renderLabels(pairs)} ${String(s.count)}`);
    }
    return Promise.resolve(lines);
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  private add<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) throw new Error(`metric "${metric.name}" already exists`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(options: MetricOptions): Counter {
    return this.add(new Counter(options));
  }

  gauge(options: GaugeOptions): Gauge {
    return this.add(new Gauge(options));
  }

  histogram(options: HistogramOptions): Histogram {
    return this.add(new Histogram(options));
  }

  /** Prometheus text exposition of every registered metric. */
  async render(): Promise<string> {
    const blocks = await Promise.all([...this.metrics.values()].map((m) => m.render()));
    return `${blocks.flat().join('\n')}\n`;
  }
}

/**
 * Process gauges every service exposes: resident memory, heap, uptime and event-loop lag
 * (sampled with a cheap unref'd timer).
 */
export function registerProcessMetrics(registry: MetricsRegistry, prefix: string): () => void {
  let lagSeconds = 0;
  const interval = 1_000;
  let expected = Date.now() + interval;
  const timer = setInterval(() => {
    const now = Date.now();
    lagSeconds = Math.max(0, (now - expected) / 1_000);
    expected = now + interval;
  }, interval);
  timer.unref();
  const started = Date.now();
  registry.gauge({
    name: `${prefix}_process_resident_memory_bytes`,
    help: 'Resident set size of the process in bytes.',
    collect: () => Promise.resolve([{ value: process.memoryUsage().rss }]),
  });
  registry.gauge({
    name: `${prefix}_process_heap_used_bytes`,
    help: 'V8 heap used in bytes.',
    collect: () => Promise.resolve([{ value: process.memoryUsage().heapUsed }]),
  });
  registry.gauge({
    name: `${prefix}_process_uptime_seconds`,
    help: 'Seconds since the metrics registry was created.',
    collect: () => Promise.resolve([{ value: (Date.now() - started) / 1_000 }]),
  });
  registry.gauge({
    name: `${prefix}_event_loop_lag_seconds`,
    help: 'Event-loop lag observed by a 1 s timer.',
    collect: () => Promise.resolve([{ value: lagSeconds }]),
  });
  return () => clearInterval(timer);
}
