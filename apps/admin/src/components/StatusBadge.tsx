/**
 * Enforceability badge: four-state status (D-028) × evidence level
 * (MULTI_VENDOR_INTEGRATION_PLAN.md §4.4). The device-enforced state ("Lab validated") is
 * reachable ONLY for VERIFIED_SUPPORTED with LAB/PRODUCTION evidence and a device-test
 * reference (V12); source-verified cells render as "Verified (source)" / "Expected (…)".
 */
import { presentStatus, type StatusPresentation } from '../lib/adapterStatus';
import { Badge } from './ui';

function icon(p: StatusPresentation): string {
  if (p.deviceEnforced) return '✓';
  if (p.tone === 'danger') return '✕';
  if (p.status === 'VERIFIED_SUPPORTED') return '○';
  return '!';
}

export function StatusBadge({
  status,
  evidence,
  evidenceLevel,
  dtRefs,
  mode = 'catalogue',
  legend = false,
}: {
  status: unknown;
  evidence?: string;
  evidenceLevel?: unknown;
  dtRefs?: readonly string[];
  /** `preview` uses the policy-preview wording ("Expected (source-verified, not device-tested)"). */
  mode?: 'catalogue' | 'preview';
  /** Legend sample: not a capability claim, excluded from data-status queries. */
  legend?: boolean;
}) {
  const p = presentStatus(status, evidenceLevel, { dtRefs });
  const label = mode === 'preview' ? p.previewLabel : p.label;
  const title = evidence ? `${p.description}\nEvidence: ${evidence}` : p.description;
  return (
    <span
      data-status={legend ? undefined : p.status}
      data-evidence-level={legend ? undefined : (p.evidenceLevel ?? 'none')}
      data-legend-status={legend ? p.status : undefined}
      data-device-enforced={legend ? undefined : p.deviceEnforced ? 'true' : 'false'}
      data-variant={p.variant}
    >
      <Badge tone={p.tone} title={title}>
        <span aria-hidden="true">{icon(p)}</span>
        {label}
        <span className="sr-only">: {p.description}</span>
      </Badge>
    </span>
  );
}

const LEGEND: readonly { status: string; evidenceLevel?: string; dtRefs?: string[] }[] = [
  { status: 'VERIFIED_SUPPORTED', evidenceLevel: 'LAB_VALIDATED', dtRefs: ['DT-xx'] },
  { status: 'VERIFIED_SUPPORTED', evidenceLevel: 'VERIFIED_FROM_SOURCE' },
  { status: 'REQUIRES_DEVICE_TEST' },
  { status: 'ECLOUD_SIDE_ONLY' },
  { status: 'UNSUPPORTED' },
];

export function StatusLegend({ mode = 'catalogue' }: { mode?: 'catalogue' | 'preview' }) {
  return (
    <ul className="flex flex-wrap gap-2 text-xs" aria-label="Status legend">
      {LEGEND.map((s) => {
        const p = presentStatus(s.status, s.evidenceLevel, { dtRefs: s.dtRefs });
        return (
          <li key={`${s.status}-${s.evidenceLevel ?? ''}`} className="flex items-center gap-1">
            <StatusBadge
              status={s.status}
              evidenceLevel={s.evidenceLevel}
              dtRefs={s.dtRefs}
              mode={mode}
              legend
            />
            <span className="text-subtle">
              {p.deviceEnforced ? 'Proven on a recorded lab device test.' : p.description}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
