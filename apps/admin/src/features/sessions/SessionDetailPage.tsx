/**
 * Session detail (P8-B): identity, counters and freshness, the accounting timeline (normalised
 * records), accounting anomalies, enforcement rows and session actions, plus the gated
 * Disconnect / Re-authorize buttons. Polled every 30 s while the session is open (Q73).
 * Sections the connected API does not return are reported as not available rather than empty.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { buildUrl, request } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { FreshnessLine } from '../../components/Freshness';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Badge, Card, Notice, PageHeader, Spinner } from '../../components/ui';
import { RequireOrgPermission } from '../../layout/guards';
import {
  isOpenSession,
  POLL_INTERVAL_MS,
  SESSION_PATH,
  sessionFreshness,
  sessionStateLabel,
  sessionStateTone,
  type SessionDetail,
} from '../../lib/accounting';
import { stateTone, strategyLabel } from '../../lib/enforcement';
import { display, formatBytes, formatDateTime, formatDuration } from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { OperationButton } from './SessionOperations';
import { useOperationGates } from './useOperationGates';

function NotReturned({ what }: { what: string }) {
  return (
    <Notice tone="warning" title="Not available in this API version">
      The connected API does not return the {what} for a session yet.
    </Notice>
  );
}

function Detail({ orgId, s }: { orgId: string; s: SessionDetail }) {
  const gateFor = useOperationGates(orgId);
  const open = isOpenSession(s.status);
  return (
    <div className="space-y-4">
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            {display(s.username_raw)}
            <Badge tone={sessionStateTone(s.status)}>{sessionStateLabel(s.status)}</Badge>
          </span>
        }
        actions={
          open ? (
            <>
              {(['disconnect', 'reauthorize'] as const).map((op) => (
                <OperationButton
                  key={op}
                  operation={op}
                  gate={gateFor(s, op)}
                  orgId={orgId}
                  sessionId={s.id}
                  label={display(s.username_raw ?? s.mac)}
                />
              ))}
            </>
          ) : null
        }
      >
        {open ? (
          <div className="mb-3">
            <FreshnessLine freshness={sessionFreshness(s)} />
          </div>
        ) : null}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr_max-content_1fr]">
          <dt className="text-subtle">Client MAC</dt>
          <dd className="font-mono">{display(s.mac)}</dd>
          <dt className="text-subtle">IP</dt>
          <dd className="font-mono">{display(s.framed_ip)}</dd>
          <dt className="text-subtle">Site</dt>
          <dd>{display(s.site_name ?? s.site_id)}</dd>
          <dt className="text-subtle">NAS</dt>
          <dd>
            {display(s.nas?.name ?? s.nas_name ?? s.nas_client_id)}
            {(s.nas?.adapter_key ?? s.adapter_key) ? (
              <span className="font-mono text-xs"> ({s.nas?.adapter_key ?? s.adapter_key})</span>
            ) : (
              <span className="text-xs text-subtle"> (no engine adapter)</span>
            )}
          </dd>
          <dt className="text-subtle">Policy</dt>
          <dd>{display(s.policy_name)}</dd>
          <dt className="text-subtle">Started</dt>
          <dd>{formatDateTime(s.started_at)}</dd>
          <dt className="text-subtle">Stopped</dt>
          <dd>
            {formatDateTime(s.stopped_at)}
            {s.terminate_cause ? ` (${display(s.terminate_cause)})` : ''}
          </dd>
          <dt className="text-subtle">Duration</dt>
          <dd>{formatDuration(s.session_time_s)}</dd>
          <dt className="text-subtle">Downloaded / uploaded</dt>
          <dd>
            {formatBytes(s.output_octets)} / {formatBytes(s.input_octets)}
          </dd>
        </dl>
        <p className="mt-3 text-sm">
          <Link
            to={`/orgs/${orgId}/sessions/${s.id}/enforcement`}
            className="text-primary hover:underline"
          >
            Policy enforcement view →
          </Link>
        </p>
      </Card>

      <Card title="Accounting timeline">
        {s.timeline === undefined ? (
          <NotReturned what="accounting timeline" />
        ) : (
          <>
            {s.timeline_truncated ? (
              <div className="mb-3">
                <Notice tone="info">
                  Showing the most recent records only; use the accounting record browser for the
                  full history.
                </Notice>
              </div>
            ) : null}
            <DataTable
              caption="Accounting timeline"
              rows={s.timeline}
              rowKey={(r) => String(r.id)}
              emptyTitle="No accounting received for this session"
              columns={[
                { key: 'status_type', header: 'Record' },
                {
                  key: 'event_time',
                  header: 'Event time (NAS)',
                  render: (r) => formatDateTime(r.event_time),
                },
                {
                  key: 'received_at',
                  header: 'Received',
                  render: (r) => formatDateTime(r.received_at),
                },
                {
                  key: 'session_time_s',
                  header: 'Session time',
                  render: (r) => formatDuration(r.session_time_s),
                },
                {
                  key: 'input_octets',
                  header: 'In (counter)',
                  render: (r) => formatBytes(r.input_octets),
                },
                {
                  key: 'output_octets',
                  header: 'Out (counter)',
                  render: (r) => formatBytes(r.output_octets),
                },
                {
                  key: 'delta',
                  header: 'Added',
                  render: (r) =>
                    r.delta_input_octets === undefined && r.delta_output_octets === undefined
                      ? '—'
                      : `${formatBytes(r.delta_input_octets)} / ${formatBytes(r.delta_output_octets)}`,
                },
                { key: 'terminate_cause', header: 'Cause' },
              ]}
            />
          </>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Accounting anomalies">
          {s.anomalies === undefined ? (
            <NotReturned what="accounting anomalies" />
          ) : (
            <DataTable
              caption="Accounting anomalies"
              rows={s.anomalies}
              rowKey={(a) => a.id}
              emptyTitle="No anomalies recorded"
              columns={[
                { key: 'kind', header: 'Kind', render: (a) => display(a.kind ?? a.counter) },
                { key: 'previous', header: 'Previous' },
                { key: 'observed', header: 'Observed' },
                {
                  key: 'estimated_lost_bytes',
                  header: 'Estimated',
                  render: (a) => formatBytes(a.estimated_lost_bytes),
                },
                {
                  key: 'applied',
                  header: 'Usage corrected',
                  render: (a) => display(a.applied),
                },
                { key: 'reason', header: 'Reason' },
                {
                  key: 'created_at',
                  header: 'At',
                  render: (a) => formatDateTime(a.created_at),
                },
              ]}
            />
          )}
        </Card>

        <Card title="Policy enforcement">
          {s.enforcement === undefined ? (
            <NotReturned what="enforcement rows" />
          ) : (
            <DataTable
              caption="Enforcement rows"
              rows={s.enforcement}
              rowKey={(e) => e.id}
              emptyTitle="No policy change has affected this session"
              columns={[
                {
                  key: 'state',
                  header: 'State',
                  render: (e) => <Badge tone={stateTone(e.state)}>{display(e.state)}</Badge>,
                },
                { key: 'strategy', header: 'Strategy', render: (e) => strategyLabel(e.strategy) },
                { key: 'trigger', header: 'Trigger' },
                { key: 'reason', header: 'Reason', className: 'px-3 py-2 align-top' },
                {
                  key: 'created_at',
                  header: 'Created',
                  render: (e) => formatDateTime(e.created_at),
                },
              ]}
            />
          )}
        </Card>
      </div>

      <Card title="Session actions">
        {s.session_actions === undefined ? (
          <NotReturned what="session actions" />
        ) : (
          <DataTable
            caption="Session actions"
            rows={s.session_actions}
            rowKey={(a) => a.id}
            emptyTitle="No Disconnect or CoA request was sent for this session"
            columns={[
              { key: 'action', header: 'Action' },
              {
                key: 'status',
                header: 'Result reported',
                render: (a) => <Badge>{display(a.status)}</Badge>,
              },
              { key: 'created_at', header: 'Sent', render: (a) => formatDateTime(a.created_at) },
              {
                key: 'completed_at',
                header: 'Completed',
                render: (a) => formatDateTime(a.completed_at),
              },
              { key: 'error', header: 'Error' },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

function Screen() {
  const orgId = useOrgId();
  const { sessionId = '' } = useParams();
  const query = useQuery<SessionDetail>({
    queryKey: ['org', orgId, 'sessions', 'detail', sessionId],
    enabled: sessionId !== '',
    refetchInterval: (q) =>
      q.state.data && isOpenSession(q.state.data.status) ? POLL_INTERVAL_MS : false,
    queryFn: ({ signal }) =>
      request<SessionDetail>('get', buildUrl(SESSION_PATH, { orgId, id: sessionId }, undefined), {
        signal,
        pathTemplate: SESSION_PATH,
      }),
  });
  return (
    <div>
      <PageHeader
        title="Session"
        description={
          <Link to={`/orgs/${orgId}/sessions`} className="text-primary hover:underline">
            ← All sessions
          </Link>
        }
      />
      {query.isPending ? (
        <Spinner label="Loading session…" />
      ) : query.error ? (
        <ProblemAlert error={query.error} />
      ) : (
        <Detail orgId={orgId} s={query.data} />
      )}
    </div>
  );
}

export function SessionDetailPage() {
  return (
    <RequireOrgPermission permission="session:read">
      <Screen />
    </RequireOrgPermission>
  );
}
