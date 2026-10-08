/**
 * Enforceability preview (ADMIN_UI_ARCHITECTURE.md §3 "core UX"). Calls
 * GET /policies/simulate for a chosen subject and renders, per adapter, the four-state status
 * of every field set in the draft. The API resolves SAVED policies/assignments for the subject;
 * the per-field statuses come from the adapters' capability declarations and therefore apply
 * to the draft too. Without a subject, platform operators see the static adapter catalogue.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Badge, Card, Notice, SelectField, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { display, str } from '../../lib/format';
import { canPlatform } from '../../lib/permissions';
import { useOptions } from '../resource/useOptions';
import { EnforceabilityMatrix, toAdapterColumns } from './EnforceabilityMatrix';

export function PreviewPanel({
  orgId,
  draftFields,
}: {
  orgId: string;
  draftFields: readonly string[];
}) {
  const { me } = useAuth();
  const [userId, setUserId] = useState('');
  const [siteId, setSiteId] = useState('');
  const users = useOptions(orgId, {
    path: '/api/v1/orgs/{orgId}/users',
    label: (r) => str(r.username ?? r.id),
  });
  const sites = useOptions(orgId, {
    path: '/api/v1/orgs/{orgId}/sites',
    label: (r) => str(r.name ?? r.id),
  });

  const simulation = useQuery({
    queryKey: ['org', orgId, 'simulate', userId, siteId],
    enabled: userId !== '',
    queryFn: ({ signal }) =>
      api('get', '/api/v1/orgs/{orgId}/policies/simulate', {
        params: { orgId },
        query: { user_id: userId, ...(siteId ? { site_id: siteId } : {}) },
        signal,
      }) as Promise<Record<string, unknown>>,
  });

  const catalogue = useQuery({
    queryKey: ['platform', 'adapters'],
    enabled: userId === '' && canPlatform(me, 'platform:health:read'),
    queryFn: ({ signal }) => api('get', '/api/v1/platform/adapters', { signal }),
  });

  const sim = simulation.data;
  const simColumns = toAdapterColumns(sim?.per_adapter);
  const rows =
    draftFields.length > 0
      ? draftFields
      : [...new Set(simColumns.flatMap((c) => c.fields.filter((f) => f.set).map((f) => f.field)))];
  const effective = (sim?.effective ?? null) as Record<string, unknown> | null;

  return (
    <Card title="Enforceability preview">
      <div className="space-y-4">
        <Notice tone="info">
          Only <strong>Verified</strong> fields are enforced by the device. “Needs device test”
          values are sent but unverified; “ECLOUD side” values are enforced by ECLOUD itself
          (D-028).
        </Notice>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField
            label="Simulate for user"
            options={users.data ?? []}
            placeholder="— choose a user —"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
          <SelectField
            label="At site"
            options={sites.data ?? []}
            placeholder="— user’s site —"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
          />
        </div>

        {userId === '' ? (
          catalogue.data ? (
            <EnforceabilityMatrix
              adapters={toAdapterColumns(catalogue.data.adapters)}
              fields={draftFields}
              caption="Adapter capability catalogue"
            />
          ) : catalogue.isFetching ? (
            <Spinner label="Loading adapter catalogue…" />
          ) : (
            <p className="text-sm text-subtle">
              Choose a user to resolve their effective policy and see per-adapter enforceability.
            </p>
          )
        ) : simulation.isPending ? (
          <Spinner label="Simulating…" />
        ) : simulation.error ? (
          <ProblemAlert error={simulation.error} />
        ) : sim ? (
          <div className="space-y-3">
            <p className="text-sm">
              Decision:{' '}
              <Badge tone={sim.decision === 'accept' ? 'success' : 'danger'}>
                {display(sim.decision)}
              </Badge>
              {sim.reason_code ? (
                <span className="ml-2 text-subtle">
                  {display(sim.reason_code)}
                  {sim.reason_detail ? ` — ${display(sim.reason_detail)}` : ''}
                </span>
              ) : null}
            </p>
            {effective ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-primary">
                  Effective policy (saved data)
                </summary>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {Object.entries(effective)
                    .filter(([, v]) => v !== null && typeof v !== 'object')
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-subtle">{k}</dt>
                        <dd className="font-mono">{display(v)}</dd>
                      </div>
                    ))}
                </dl>
              </details>
            ) : null}
            <EnforceabilityMatrix adapters={simColumns} fields={rows} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
