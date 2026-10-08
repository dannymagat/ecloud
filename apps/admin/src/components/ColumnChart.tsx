/**
 * Stacked column chart for time buckets (dataviz guidance: thin ≤ 24 px columns from a zero
 * baseline, 4 px rounded data-end, 2 px surface gap between stacked segments, hairline recessive
 * grid, one y-axis starting at 0, legend for ≥ 2 series, text in text tokens, per-column hover /
 * keyboard-focus tooltip, and a data-table view so no value is gated behind hover).
 * Colours come from the `--viz-*` tokens (styles.css), selected per theme.
 */
import { useId, useState, type ReactNode } from 'react';
import { EmptyState } from './ui';

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS colour, normally `var(--viz-N)`. */
  color: string;
}

export interface ChartPoint {
  key: string;
  /** Short axis label. */
  label: string;
  /** Full label for the tooltip / table. */
  title: string;
  values: Record<string, number>;
}

/** "Nice" ticks from 0 to ≥ max (1 / 2 / 2.5 / 5 × 10^n steps). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

const W = 720;
const H = 240;
// left margin fits byte tick labels such as "1000.0 MB" plus the rotated axis title without overlap
const M = { top: 12, right: 12, bottom: 30, left: 84 };

/** Column with a rounded (4 px) top and a square base. */
function columnPath(x: number, y: number, w: number, h: number, round: boolean): string {
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function ColumnChart({
  title,
  series,
  points,
  formatValue,
  yLabel,
  xLabel,
  emptyTitle,
  dimmed = false,
  tickUnit = 1,
  footer,
}: {
  title: string;
  series: readonly ChartSeries[];
  points: readonly ChartPoint[];
  formatValue: (v: number) => string;
  yLabel: string;
  xLabel: string;
  emptyTitle: string;
  /** Refetch in progress: keep the frame, reduce opacity. */
  dimmed?: boolean;
  /** Ticks are "nice" in this unit (e.g. 1024³ for GB) so byte axes read 0 / 2 / 4 GB. */
  tickUnit?: number;
  footer?: ReactNode;
}) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const totals = points.map((p) => series.reduce((s, ser) => s + (p.values[ser.key] ?? 0), 0));
  const max = Math.max(0, ...totals);
  const table = (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-xs text-subtle">Show data table</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-md border border-border">
        <table className="min-w-full divide-y divide-border text-sm">
          <caption className="sr-only">{title} (data)</caption>
          <thead className="bg-muted/60">
            <tr>
              <th scope="col" className="px-3 py-1.5 text-left text-xs font-semibold text-subtle">
                {xLabel}
              </th>
              {series.map((s) => (
                <th
                  key={s.key}
                  scope="col"
                  className="px-3 py-1.5 text-right text-xs font-semibold text-subtle"
                >
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {points.map((p) => (
              <tr key={p.key}>
                <th scope="row" className="whitespace-nowrap px-3 py-1 text-left font-normal">
                  {p.title}
                </th>
                {series.map((s) => (
                  <td key={s.key} className="px-3 py-1 text-right tabular-nums">
                    {formatValue(p.values[s.key] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );

  if (points.length === 0 || max === 0) {
    return (
      <figure aria-label={title} data-chart="empty">
        <EmptyState title={emptyTitle} />
        {points.length > 0 ? table : null}
      </figure>
    );
  }

  const ticks = niceTicks(max / tickUnit).map((t) => t * tickUnit);
  const top = ticks[ticks.length - 1]!;
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const band = plotW / points.length;
  const barW = Math.max(1, Math.min(24, band * 0.7));
  const y = (v: number) => M.top + plotH - (v / top) * plotH;
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const activePoint = active !== null ? points[active] : undefined;

  return (
    <figure aria-label={title} className="relative" data-chart="columns">
      {series.length > 1 ? (
        <ul className="mb-2 flex flex-wrap gap-4 text-xs text-subtle" aria-label="Legend">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <svg width="10" height="10" aria-hidden="true">
                <rect width="10" height="10" rx="2" fill={s.color} />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={dimmed ? 'h-auto w-full opacity-60 transition-opacity' : 'h-auto w-full'}
        role="group"
        aria-labelledby={`${id}-title`}
        onMouseLeave={() => setActive(null)}
      >
        <title id={`${id}-title`}>{title}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={M.left}
              x2={W - M.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
              strokeWidth={1}
            />
            <text
              x={M.left - 6}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              className="fill-subtle text-[11px] tabular-nums"
            >
              {formatValue(t)}
            </text>
          </g>
        ))}
        <text
          transform={`translate(10 ${M.top + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          className="fill-subtle text-[11px]"
        >
          {yLabel}
        </text>
        {points.map((p, i) => {
          const x = M.left + i * band + (band - barW) / 2;
          let acc = 0;
          const visible = series.filter((s) => (p.values[s.key] ?? 0) > 0);
          return (
            <g key={p.key}>
              {visible.map((s, j) => {
                const v = p.values[s.key] ?? 0;
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                const isTop = j === visible.length - 1;
                // 2 px surface gap between stacked segments.
                const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
                return (
                  <path
                    key={s.key}
                    d={columnPath(x, y1, barW, h, isTop)}
                    fill={s.color}
                    opacity={active === null || active === i ? 1 : 0.55}
                  />
                );
              })}
              {i % labelEvery === 0 ? (
                <text
                  x={M.left + i * band + band / 2}
                  y={H - M.bottom + 16}
                  textAnchor="middle"
                  className="fill-subtle text-[11px]"
                >
                  {p.label}
                </text>
              ) : null}
              <rect
                x={M.left + i * band}
                y={M.top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                role="img"
                aria-label={`${p.title}: ${series
                  .map((s) => `${s.label} ${formatValue(p.values[s.key] ?? 0)}`)
                  .join(', ')}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="outline-none focus-visible:stroke-primary"
              />
            </g>
          );
        })}
      </svg>
      {activePoint ? (
        <div
          role="status"
          className="pointer-events-none absolute right-2 top-0 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-sm"
        >
          <p className="text-subtle">{activePoint.title}</p>
          {series.map((s) => (
            <p key={s.key} className="flex items-center gap-2">
              <svg width="12" height="4" aria-hidden="true">
                <rect width="12" height="2" y="1" fill={s.color} />
              </svg>
              <span className="font-semibold tabular-nums">
                {formatValue(activePoint.values[s.key] ?? 0)}
              </span>
              <span className="text-subtle">{s.label}</span>
            </p>
          ))}
        </div>
      ) : null}
      <figcaption className="sr-only">
        {title}. {xLabel} on the horizontal axis, {yLabel} on the vertical axis starting at zero.
      </figcaption>
      {footer}
      {table}
    </figure>
  );
}
