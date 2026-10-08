/**
 * Per-session enforcement view (Phase 7 P7-B AC3) over the P7-A contract
 * `GET /api/v1/orgs/{orgId}/sessions/{id}/enforcement`: the effective-policy snapshot, the
 * attributes actually sent at authorize, each field's status / evidence / device-enforced flag
 * with amber flags (Q67), the change strategy and any pending change. Feature-detected: against
 * an API without the endpoint the screen says so instead of failing.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { buildUrl, request } from '../../api/client';
import { AmberFlag } from '../../components/AmberFlag';
import { DataTable } from '../../components/DataTable';
import { ProblemAlert } from '../../components/ProblemAlert';
import { StatusBadge } from '../../components/StatusBadge';
import { Badge, Card, Notice, PageHeader, Spinner } from '../../components/ui';
import { Unavailable } from '../../components/Unavailable';
import { RequireOrgPermission } from '../../layout/guards';
import { fieldLabel } from '../../lib/adapterStatus';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import {
  isAmberStatus,
  SESSION_ENFORCEMENT_PATH,
  showDeviceEnforced,
  stateTone,
  strategyLabel,
  type EnforcementChange,
  type EnforcementField,
  type SessionEnforcementView,
} from '../../lib/enforcement';
import { display, formatBytes, formatDateTime, formatDuration, str } from '../../lib/format';
import { useOrgId } from '../../lib/org';

/** Server flag, or the status itself says amber (never under-flag a payload). */
function amber(f: EnforcementField): boolean {
  return f.amber || isAmberStatus(f.status);
}

function ChangeLine({ change }: { change: EnforcementChange }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={stateTone(change.state)}>{display(change.state)}</Badge>
        <span>{strategyLabel(change.strategy)}</span>
        <span className="text-subtle">· trigger {display(change.trigger)}</span>
      </p>
      <p className="text-subtle">{change.reason}</p>
      {change.expected_apply_by ? (
        <p>
          Expected to apply by <strong>{formatDateTime(change.expected_apply_by)}</strong>{' '}
          <span className="text-subtle">(next re-authentication, Session-Timeout bound)</span>
        </p>
      ) : null}
    </div>
  );
}

function View({ view }: { view: SessionEnforcementView }) {
  const evidence = view.strategy_evidence;
  const amberCount = view.fields.filter((f) => f.set && amber(f)).length;
  return (
    <div className="space-y-4">
      <Notice tone="info">
        A field is device-enforced only when it is verified supported with lab-validated evidence
        (D-028); none is yet. Amber-flagged fields are sent or tracked by ECLOUD but not proven on a
        device.
      </Notice>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Session">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-subtle">Status</dt>
            <dd>{display(view.status)}</dd>
            <dt className="text-subtle">NAS adapter</dt>
            <dd className="font-mono">
              {view.adapter_key ?? 'none (no engine adapter)'}
              {view.adapter_version ? ` @ ${view.adapter_version}` : ''}
            </dd>
            <dt className="text-subtle">Policy snapshot</dt>
            <dd>
              {view.snapshot
                ? `${str(view.snapshot.policy_id ?? 'organization default / none')} · version ${display(view.snapshot.policy_version)}`
                : '—'}
            </dd>
            <dt className="text-subtle">Snapshot hash</dt>
            <dd className="break-all font-mono text-xs">{view.snapshot?.hash ?? '—'}</dd>
            <dt className="text-subtle">Authorized at</dt>
            <dd>{formatDateTime(view.snapshot?.authorized_at)}</dd>
            <dt className="text-subtle">Session-Timeout</dt>
            <dd>
              {view.session_timeout.value_s === null
                ? 'not set'
                : `${formatDuration(view.session_timeout.value_s)} (${view.session_timeout.sent ? 'sent' : 'not sent'})`}
              {view.session_timeout.expected_reauth_by
                ? ` · re-auth by ${formatDateTime(view.session_timeout.expected_reauth_by)}`
                : ''}
            </dd>
          </dl>
        </Card>

        <Card title="Policy changes">
          <div className="space-y-3">
            {view.pending_change ? (
              <ChangeLine change={view.pending_change} />
            ) : (
              <p className="text-sm text-subtle">No pending change for this session.</p>
            )}
            <div className="border-t border-border pt-3 text-sm">
              <p>
                A change made now would apply: <strong>{strategyLabel(evidence.strategy)}</strong>
              </p>
              <ul className="mt-1 space-y-1 text-subtle">
                <li className="flex flex-wrap items-center gap-2">
                  CoA change:{' '}
                  <StatusBadge
                    status={evidence.coa_change.status}
                    evidenceLevel={evidence.coa_change.evidence_level}
                  />
                </li>
                <li className="flex flex-wrap items-center gap-2">
                  Disconnect:{' '}
                  <StatusBadge
                    status={evidence.disconnect.status}
                    evidenceLevel={evidence.disconnect.evidence_level}
                  />
                </li>
                <li>
                  CoA / Disconnect dispatcher:{' '}
                  {evidence.dispatcher_enabled ? 'enabled' : 'disabled (default, D-006)'}
                </li>
              </ul>
            </div>
          </div>
        </Card>
      </div>

      <Card title={`Fields${amberCount > 0 ? ` · ${amberCount} amber-flagged` : ''}`}>
        <DataTable
          caption="Policy fields and enforcement"
          rows={view.fields.filter((f) => f.set)}
          rowKey={(f) => f.field}
          emptyTitle="No policy field is set for this session"
          columns={[
            { key: 'field', header: 'Field', render: (f) => fieldLabel(f.field) },
            {
              key: 'value',
              header: 'Value',
              render: (f) =>
                f.field.startsWith('quota_') ? formatBytes(f.value) : display(f.value),
            },
            {
              key: 'status',
              header: 'Status',
              render: (f) => (
                <StatusBadge
                  status={f.status}
                  evidence={f.evidence}
                  evidenceLevel={f.evidence_level}
                />
              ),
            },
            {
              key: 'device_enforced',
              header: 'Device enforced',
              render: (f) =>
                showDeviceEnforced(f.device_enforced, f.status, f.evidence_level) ? 'Yes' : 'No',
            },
            { key: 'mechanism', header: 'Mechanism', render: (f) => display(f.mechanism) },
            {
              key: 'attributes',
              header: 'Attributes',
              render: (f) =>
                f.attributes.length > 0 ? (
                  <code className="text-xs">{f.attributes.join(', ')}</code>
                ) : (
                  '—'
                ),
            },
            {
              key: 'flag',
              header: 'Flag',
              render: (f) => (amber(f) ? <AmberFlag status={f.status} /> : null),
            },
          ]}
        />
        {view.unenforceable.length > 0 ? (
          <div className="mt-3">
            <Notice tone="warning" title="Not enforceable on this NAS">
              <ul className="list-disc pl-5">
                {view.unenforceable.map((u) => (
                  <li key={u.field}>
                    {fieldLabel(u.field)}: {display(u.reason)}
                    {u.detail ? ` — ${u.detail}` : ''}
                  </li>
                ))}
              </ul>
            </Notice>
          </div>
        ) : null}
      </Card>

      <Card title="Attributes sent at authorization">
        <DataTable
          caption="RADIUS reply attributes sent"
          rows={view.attributes_sent}
          rowKey={(a) => `${a.name}:${String(a.value)}`}
          emptyTitle="No policy attributes were sent"
          columns={[
            {
              key: 'name',
              header: 'Attribute',
              render: (a) => <code className="text-xs">{a.name}</code>,
            },
            { key: 'value', header: 'Value', render: (a) => display(a.value) },
            { key: 'field', header: 'Field', render: (a) => fieldLabel(a.field) },
            {
              key: 'status',
              header: 'Status',
              render: (a) => (
                <span className="inline-flex flex-wrap items-center gap-1">
                  <StatusBadge status={a.status} evidenceLevel={a.evidence_level} />
                  {a.experimental ? <Badge tone="warning">experimental</Badge> : null}
                  <AmberFlag status={a.status} />
                </span>
              ),
            },
          ]}
        />
      </Card>

      {view.history.length > 0 ? (
        <Card title="Change history">
          <ul className="space-y-3">
            {view.history.map((h) => (
              <li key={h.id} className="border-b border-border pb-3 last:border-0">
                <ChangeLine change={h} />
                <p className="text-xs text-subtle">
                  {formatDateTime(h.created_at)}
                  {h.resolved_at ? ` → resolved ${formatDateTime(h.resolved_at)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {view.counter_anomalies.length > 0 ? (
        <Card title="Accounting counter anomalies">
          <DataTable
            caption="Accounting counter anomalies"
            rows={view.counter_anomalies}
            rowKey={(a) => a.id}
            columns={[
              { key: 'counter', header: 'Counter' },
              { key: 'previous', header: 'Previous' },
              { key: 'observed', header: 'Observed' },
              {
                key: 'estimated_lost_bytes',
                header: 'Estimated wrap',
                render: (a) => formatBytes(a.estimated_lost_bytes),
              },
              {
                key: 'applied',
                header: 'Usage corrected',
                render: (a) => (a.applied ? 'Yes' : 'No'),
              },
              { key: 'reason', header: 'Reason' },
            ]}
          />
        </Card>
      ) : null}
    </div>
  );
}

function Screen() {
  const orgId = useOrgId();
  const { sessionId = '' } = useParams();
  const doc = useApiDocument();
  const available = hasOperation(doc.data, 'get', SESSION_ENFORCEMENT_PATH);
  const query = useQuery({
    queryKey: ['org', orgId, 'session-enforcement', sessionId],
    enabled: available && sessionId !== '',
    queryFn: ({ signal }) =>
      request<SessionEnforcementView>(
        'get',
        buildUrl(SESSION_ENFORCEMENT_PATH, { orgId, id: sessionId }, undefined),
        { signal, pathTemplate: SESSION_ENFORCEMENT_PATH },
      ),
  });
  return (
    <div>
      <PageHeader
        title="Session enforcement"
        description={
          <Link to={`/orgs/${orgId}/sessions`} className="text-primary hover:underline">
            ← All sessions
          </Link>
        }
      />
      {doc.isPending ? (
        <Spinner label="Loading…" />
      ) : !available ? (
        <Unavailable endpoint={`GET ${SESSION_ENFORCEMENT_PATH}`} />
      ) : query.isPending ? (
        <Spinner label="Loading enforcement view…" />
      ) : query.error ? (
        <ProblemAlert error={query.error} />
      ) : (
        <View view={query.data} />
      )}
    </div>
  );
}

export function SessionEnforcementPage() {
  return (
    <RequireOrgPermission permission="session:read">
      <Screen />
    </RequireOrgPermission>
  );
}
