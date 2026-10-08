/**
 * Sessions (P8-B): live list polled every 30 s (Q73), state chips, filters (site, NAS, user,
 * client MAC, time range — each sent only when the connected API declares it), per-row
 * accounting freshness, and Disconnect / Re-authorize buttons gated on registry evidence
 * (D-006, V12).
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { buildUrl, request } from '../../api/client';
import type { Page } from '../../api/types';
import { DataTable } from '../../components/DataTable';
import { FRESHNESS_EXPLAINER, FreshnessBadge } from '../../components/Freshness';
import { Badge, Card, cx, PageHeader, SelectField, TextField } from '../../components/ui';
import { RequireOrgPermission } from '../../layout/guards';
import {
  isOpenSession,
  POLL_INTERVAL_MS,
  SESSION_STATE_HINT,
  SESSION_STATE_LABEL,
  SESSION_STATES,
  SESSIONS_PATH,
  sessionFreshness,
  sessionStateLabel,
  sessionStateTone,
  type SessionRow,
  type SessionState,
} from '../../lib/accounting';
import { hasParameter, useApiDocument } from '../../lib/apiDoc';
import { useAuth } from '../../lib/auth';
import {
  display,
  formatBytes,
  formatDateTime,
  formatDuration,
  localInputToIso,
} from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';
import { useCursorList } from '../../lib/queries';
import { useOptions } from '../resource/useOptions';
import { OperationButton } from './SessionOperations';
import { useOperationGates } from './useOperationGates';

type StateFilter = SessionState | 'all' | 'open';

export function StateChips({
  value,
  onChange,
  available,
}: {
  value: StateFilter;
  onChange: (v: StateFilter) => void;
  available: (s: StateFilter) => boolean;
}) {
  const chips: { key: StateFilter; label: string; hint?: string }[] = [
    { key: 'open', label: 'Open', hint: 'Authorized or active: sessions that may be online now' },
    { key: 'all', label: 'All' },
    ...SESSION_STATES.map((s) => ({
      key: s,
      label: SESSION_STATE_LABEL[s],
      hint: SESSION_STATE_HINT[s],
    })),
  ];
  return (
    <div role="radiogroup" aria-label="Session state" className="flex flex-wrap gap-2">
      {chips.map((c) => {
        const enabled = c.key === 'all' || available(c.key);
        return (
          <button
            key={c.key}
            type="button"
            role="radio"
            aria-checked={value === c.key}
            disabled={!enabled}
            title={c.hint}
            onClick={() => onChange(c.key)}
            className={cx(
              'rounded-full border px-3 py-1 text-xs font-medium',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary',
              'disabled:cursor-not-allowed disabled:opacity-50',
              value === c.key
                ? 'border-primary bg-primary text-primary-fg'
                : 'border-border bg-surface hover:bg-muted',
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

const MAC_RE = /^[0-9a-fA-F]{2}([:-]?[0-9a-fA-F]{2}){5}$/;

function SessionsScreen() {
  const orgId = useOrgId();
  const { me } = useAuth();
  const doc = useApiDocument();
  const [state, setState] = useState<StateFilter>('open');
  const [siteId, setSiteId] = useState('');
  const [nasId, setNasId] = useState('');
  const [user, setUser] = useState('');
  const [mac, setMac] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const supports = (name: string) => hasParameter(doc.data, 'get', SESSIONS_PATH, name);
  const statusEnum = doc.data?.paths[SESSIONS_PATH]?.get?.parameters?.find(
    (p) => p.name === 'status',
  )?.schema?.enum;
  const userParam = supports('username') ? 'username' : supports('user') ? 'user' : null;
  const macValid = mac.trim() === '' || MAC_RE.test(mac.trim());

  const filters: Record<string, string | undefined> = {
    // `open=true` (authorized + active); an API without it gets the active sessions.
    open: state === 'open' && supports('open') ? 'true' : undefined,
    status:
      state === 'all' || state === 'open'
        ? state === 'open' && !supports('open')
          ? 'active'
          : undefined
        : state,
    site_id: supports('site_id') && siteId ? siteId : undefined,
    nas_client_id: supports('nas_client_id') && nasId ? nasId : undefined,
    mac: supports('mac') && macValid && mac.trim() ? mac.trim() : undefined,
    from: supports('from') ? (localInputToIso(from) ?? undefined) : undefined,
    to: supports('to') ? (localInputToIso(to) ?? undefined) : undefined,
  };
  if (userParam && user.trim()) filters[userParam] = user.trim();

  const list = useCursorList<SessionRow>(
    ['org', orgId, 'sessions', 'list', filters],
    (cursor, signal) =>
      request<Page<SessionRow>>(
        'get',
        buildUrl(SESSIONS_PATH, { orgId }, { limit: 50, cursor, ...filters }),
        { signal, pathTemplate: SESSIONS_PATH },
      ),
    !doc.isPending,
    { refetchInterval: POLL_INTERVAL_MS },
  );
  const anySite = { organizationId: orgId, anySite: true };
  const sites = useOptions(
    orgId,
    can(me, 'site:read', anySite)
      ? { path: '/api/v1/orgs/{orgId}/sites', label: (r) => String(r.name ?? r.id) }
      : undefined,
  );
  const nas = useOptions(
    orgId,
    can(me, 'nas:read', anySite)
      ? { path: '/api/v1/orgs/{orgId}/nas', label: (r) => String(r.name ?? r.id) }
      : undefined,
  );
  const gateFor = useOperationGates(orgId);
  const notSupported = 'Not supported by this API version';

  return (
    <div>
      <PageHeader
        title="Sessions"
        description="RADIUS sessions reported by NAS accounting, refreshed every 30 seconds. Disconnect and Re-authorize are offered only where the NAS adapter's support is lab-validated on a recorded device test."
      />
      <Card>
        <div className="mb-4 space-y-3">
          <StateChips
            value={state}
            onChange={setState}
            available={(s) =>
              s === 'all' ||
              (s === 'open' ? true : statusEnum === undefined || statusEnum.includes(s))
            }
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <SelectField
              label="Site"
              value={siteId}
              disabled={!supports('site_id')}
              onChange={(e) => setSiteId(e.target.value)}
              options={[{ value: '', label: 'All sites' }, ...(sites.data ?? [])]}
            />
            <SelectField
              label="NAS"
              value={nasId}
              disabled={!supports('nas_client_id')}
              onChange={(e) => setNasId(e.target.value)}
              options={[{ value: '', label: 'All NAS' }, ...(nas.data ?? [])]}
            />
            <TextField
              label="User"
              value={user}
              disabled={userParam === null}
              hint={userParam === null ? notSupported : undefined}
              onChange={(e) => setUser(e.target.value)}
            />
            <TextField
              label="Client MAC"
              value={mac}
              placeholder="aa:bb:cc:dd:ee:ff"
              disabled={!supports('mac')}
              hint={!supports('mac') ? notSupported : undefined}
              error={macValid ? undefined : 'Enter a MAC address'}
              onChange={(e) => setMac(e.target.value)}
            />
            <TextField
              label="Started from"
              type="datetime-local"
              value={from}
              disabled={!supports('from')}
              hint={!supports('from') ? notSupported : undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
            <TextField
              label="Started to"
              type="datetime-local"
              value={to}
              disabled={!supports('to')}
              hint={!supports('to') ? notSupported : undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <p className="text-xs text-subtle" aria-live="polite">
            {list.dataUpdatedAt > 0
              ? `Updated ${new Date(list.dataUpdatedAt).toLocaleTimeString()} · auto-refresh every ${POLL_INTERVAL_MS / 1000} s`
              : null}
            {list.isFetching && !list.isPending ? ' · refreshing…' : null}
            <span className="block">{FRESHNESS_EXPLAINER}</span>
          </p>
        </div>
        <DataTable
          caption="Sessions"
          rows={list.rows}
          rowKey={(r) => r.id}
          loading={doc.isPending || list.isPending}
          error={list.error}
          emptyTitle={
            state === 'all'
              ? 'No sessions match these filters'
              : `No ${state === 'open' ? 'open' : sessionStateLabel(state).toLowerCase()} sessions match these filters`
          }
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          columns={[
            {
              key: 'user',
              header: 'User',
              render: (r) => (
                <Link
                  to={`/orgs/${orgId}/sessions/${r.id}`}
                  className="text-primary hover:underline"
                >
                  {display(r.username_raw)}
                </Link>
              ),
            },
            { key: 'mac', header: 'MAC' },
            { key: 'framed_ip', header: 'IP' },
            { key: 'site', header: 'Site', render: (r) => display(r.site_name ?? r.site_id) },
            { key: 'nas_name', header: 'NAS' },
            { key: 'policy_name', header: 'Policy' },
            { key: 'started_at', header: 'Started', render: (r) => formatDateTime(r.started_at) },
            {
              key: 'session_time_s',
              header: 'Time',
              render: (r) => formatDuration(r.session_time_s),
            },
            { key: 'input_octets', header: 'In', render: (r) => formatBytes(r.input_octets) },
            { key: 'output_octets', header: 'Out', render: (r) => formatBytes(r.output_octets) },
            {
              key: 'status',
              header: 'State',
              render: (r) => (
                <Badge tone={sessionStateTone(r.status)}>{sessionStateLabel(r.status)}</Badge>
              ),
            },
            {
              key: 'freshness',
              header: 'Accounting',
              render: (r) =>
                isOpenSession(r.status) ? (
                  <FreshnessBadge freshness={sessionFreshness(r)} />
                ) : (
                  <span className="text-subtle">{formatDateTime(r.stopped_at)}</span>
                ),
            },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) =>
                !isOpenSession(r.status) ? (
                  <span className="text-subtle">—</span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    {(['disconnect', 'reauthorize'] as const).map((op) => (
                      <OperationButton
                        key={op}
                        operation={op}
                        gate={gateFor(r, op)}
                        orgId={orgId}
                        sessionId={r.id}
                        label={display(r.username_raw ?? r.mac)}
                      />
                    ))}
                  </span>
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

export function SessionsPage() {
  return (
    <RequireOrgPermission permission="session:read">
      <SessionsScreen />
    </RequireOrgPermission>
  );
}
