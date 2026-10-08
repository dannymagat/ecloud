/**
 * Policy change impact preview (Phase 7 P7-B AC3) over the P7-A contract
 * `POST /api/v1/orgs/{orgId}/policies/{id}/impact-preview` (writes nothing): "N sessions
 * affected; strategy next_reauth; applies at next login, at most 30 min", the per-strategy
 * breakdown and amber flags for changed fields that are REQUIRES_DEVICE_TEST / ECLOUD_SIDE_ONLY
 * on the adapters involved. Feature-detected through the live OpenAPI document.
 */
import { useMutation } from '@tanstack/react-query';
import { buildUrl, request } from '../../api/client';
import { AmberFlag } from '../../components/AmberFlag';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Badge, Button, Card, Notice } from '../../components/ui';
import { Unavailable } from '../../components/Unavailable';
import { fieldLabel } from '../../lib/adapterStatus';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import {
  IMPACT_PREVIEW_PATH,
  STRATEGIES,
  amberFlags,
  impactSummary,
  strategyLabel,
  type ImpactPreview as Impact,
} from '../../lib/enforcement';
import type { AdapterColumn } from './EnforceabilityMatrix';
import { ENFORCEMENT_FIELDS } from './policyFields';

export function ImpactPreview({
  orgId,
  policyId,
  changes,
  columns,
  allowed,
}: {
  orgId: string;
  policyId: string;
  /** The PATCH body the editor would send (changed fields only). */
  changes: Record<string, unknown>;
  /** Per-adapter field tables from the enforceability preview (simulate / catalogue). */
  columns: readonly AdapterColumn[];
  /** Caller holds `policy:preview`. */
  allowed: boolean;
}) {
  const doc = useApiDocument();
  const available = hasOperation(doc.data, 'post', IMPACT_PREVIEW_PATH);
  const preview = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      request<Impact>('post', buildUrl(IMPACT_PREVIEW_PATH, { orgId, id: policyId }, undefined), {
        body,
        pathTemplate: IMPACT_PREVIEW_PATH,
      }),
  });

  const changedFields = Object.keys(changes).filter((k) =>
    (ENFORCEMENT_FIELDS as readonly string[]).includes(k),
  );
  const impact = preview.data;
  const sessionAdapters = impact
    ? [...new Set(impact.sessions.map((s) => s.adapter_key).filter((k): k is string => k !== null))]
    : undefined;
  const flags = amberFlags(
    columns,
    changedFields,
    sessionAdapters && sessionAdapters.length > 0 ? sessionAdapters : undefined,
  );

  return (
    <Card title="Change impact on open sessions">
      {doc.isPending ? null : !available ? (
        <Unavailable endpoint={`POST ${IMPACT_PREVIEW_PATH}`} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-subtle">
            Previews which open sessions this edit would affect and how the change would reach them.
            Nothing is saved.
          </p>
          <Button
            size="sm"
            disabled={!allowed || Object.keys(changes).length === 0}
            busy={preview.isPending}
            onClick={() => preview.mutate(changes)}
            title={allowed ? undefined : 'Requires policy:preview'}
          >
            Preview impact
          </Button>
          {Object.keys(changes).length === 0 ? (
            <p className="text-xs text-subtle">Change a field to preview its impact.</p>
          ) : null}
          {preview.error ? <ProblemAlert error={preview.error} /> : null}
          {impact ? (
            <div className="space-y-3" data-testid="impact-result">
              <p className="text-sm font-medium" data-testid="impact-summary">
                {impactSummary(impact)}
              </p>
              <ul className="flex flex-wrap gap-2 text-xs">
                {STRATEGIES.filter((s) => (impact.by_strategy[s] ?? 0) > 0).map((s) => (
                  <li key={s}>
                    <Badge
                      tone={s === 'none' ? 'danger' : s === 'next_reauth' ? 'warning' : 'info'}
                    >
                      {strategyLabel(s)}: {impact.by_strategy[s]}
                    </Badge>
                  </li>
                ))}
              </ul>
              {impact.truncated ? (
                <p className="text-xs text-subtle">
                  Session list truncated to the first {impact.sessions.length}.
                </p>
              ) : null}
              {impact.affected_sessions > 0 && (impact.by_strategy.next_reauth ?? 0) > 0 ? (
                <Notice tone="warning">
                  Sessions on the next-login strategy keep their current limits until they
                  re-authenticate: live CoA / Disconnect is used only when lab validated and the
                  dispatcher is enabled (D-006). The Session-Timeout sent at login bounds the wait.
                </Notice>
              ) : null}
              {flags.length > 0 ? (
                <div>
                  <p className="text-sm font-medium">Changed fields not device-verified</p>
                  <ul className="mt-1 space-y-1 text-sm">
                    {flags.map((f) => (
                      <li
                        key={`${f.adapter}:${f.field}`}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <AmberFlag status={f.status} />
                        <span>{fieldLabel(f.field)}</span>
                        <code className="text-xs text-subtle">{f.adapter}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : changedFields.length > 0 && columns.length === 0 ? (
                <p className="text-xs text-subtle">
                  Choose a user in the enforceability preview to see per-adapter flags for the
                  changed fields.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
