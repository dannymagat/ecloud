/**
 * Subscribers + CSV import through POST /users/import: a dry run validates every row on the
 * server (all-or-nothing, existing usernames skipped), then the same CSV is committed.
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, newIdempotencyKey, type ResponseOf } from '../../api/client';
import type { Row } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Badge, Button, Notice, TextAreaField } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { display, formatDateTime, str } from '../../lib/format';
import { can } from '../../lib/permissions';
import { ResourcePage, type ResourceConfig } from '../resource/ResourcePage';

const STATUS_OPTIONS = ['active', 'suspended', 'expired', 'disabled'].map((s) => ({
  value: s,
  label: s,
}));

export const IMPORT_COLUMNS =
  'username, password, display_name, email, phone, site_id, user_group_id, status, valid_from, valid_until, max_devices, auth_methods';

type ImportResult = ResponseOf<'/api/v1/orgs/{orgId}/users/import', 'post'>;

function ImportSummary({ result }: { result: ImportResult }) {
  return (
    <div className="space-y-2" aria-live="polite">
      <Notice tone={result.dry_run ? 'info' : 'success'}>
        {result.dry_run
          ? `Validation passed: ${result.users.length} users would be created, ${result.skipped.length} skipped.`
          : `${result.created} users created, ${result.skipped.length} skipped.`}
      </Notice>
      {result.skipped.length > 0 ? (
        <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
          {result.skipped.map((s) => (
            <li key={`${s.row}-${s.username}`} className="flex gap-2">
              <Badge tone="warning">line {s.row}</Badge>
              <span>
                {s.username}: {s.reason}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ImportUsers({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api('post', '/api/v1/orgs/{orgId}/users/import', {
        params: { orgId },
        body: { csv, dry_run: dryRun },
        // The dry run and the commit are different requests: never share a key.
        idempotencyKey: dryRun ? newIdempotencyKey() : key,
      }),
    onSuccess: (result) => {
      if (!result.dry_run) {
        setKey(newIdempotencyKey());
        onDone();
      }
    },
  });
  const result = run.data;
  const validated = result?.dry_run === true;
  const committed = result !== undefined && !result.dry_run;
  const load = (value: string) => {
    setCsv(value);
    run.reset();
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>Import CSV</Button>
      <Dialog
        open={open}
        title="Import users from CSV"
        onClose={() => !run.isPending && setOpen(false)}
        wide
      >
        <div className="space-y-3 text-sm">
          <p className="text-subtle">
            Header row required. Columns:{' '}
            <code className="font-mono text-xs">{IMPORT_COLUMNS}</code> (<code>auth_methods</code>{' '}
            separated by <code>;</code>). Existing usernames are skipped.
          </p>
          <label className="block">
            <span className="text-sm font-medium">CSV file</span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="mt-1 block text-sm"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void file.text().then(load);
              }}
            />
          </label>
          <TextAreaField
            label="…or paste CSV"
            rows={6}
            value={csv}
            onChange={(e) => load(e.target.value)}
          />
          <ProblemAlert error={run.error} />
          {result ? <ImportSummary result={result} /> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOpen(false)} disabled={run.isPending}>
              Close
            </Button>
            <Button
              busy={run.isPending && run.variables === true}
              disabled={!csv.trim() || committed}
              onClick={() => run.mutate(true)}
            >
              Validate
            </Button>
            <Button
              variant="primary"
              busy={run.isPending && run.variables === false}
              disabled={!validated}
              onClick={() => run.mutate(false)}
            >
              Import
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export function UsersPage() {
  const { me } = useAuth();
  const config: ResourceConfig = {
    title: 'Users',
    singular: 'User',
    description:
      'Subscribers who authenticate on the hotspot (password, MAC, voucher or identity provider).',
    path: '/api/v1/orgs/{orgId}/users',
    permissions: {
      read: 'user:read',
      create: 'user:create',
      update: 'user:update',
      delete: 'user:delete',
    },
    columns: [
      { key: 'username', header: 'Username' },
      { key: 'display_name', header: 'Name' },
      { key: 'email', header: 'Email' },
      {
        key: 'status',
        header: 'Status',
        render: (r: Row) => (
          <Badge tone={r.status === 'active' ? 'success' : 'warning'}>{display(r.status)}</Badge>
        ),
      },
      {
        key: 'auth_methods',
        header: 'Methods',
        render: (r) => (Array.isArray(r.auth_methods) ? r.auth_methods.join(', ') : '—'),
      },
      { key: 'valid_until', header: 'Valid until', render: (r) => formatDateTime(r.valid_until) },
    ],
    fields: [
      { name: 'username', label: 'Username', type: 'text', required: true, createOnly: true },
      {
        name: 'password',
        label: 'Password',
        type: 'password',
        hint: 'Leave empty to keep / for MAC or voucher only users.',
      },
      { name: 'display_name', label: 'Display name', type: 'text', nullable: true },
      { name: 'email', label: 'Email', type: 'email', nullable: true },
      { name: 'phone', label: 'Phone', type: 'text', nullable: true },
      {
        name: 'user_group_id',
        label: 'Group',
        type: 'select',
        nullable: true,
        optionsFrom: {
          path: '/api/v1/orgs/{orgId}/user-groups',
          label: (r) => str(r.name ?? r.id),
        },
      },
      {
        name: 'site_id',
        label: 'Site',
        type: 'select',
        nullable: true,
        optionsFrom: { path: '/api/v1/orgs/{orgId}/sites', label: (r) => str(r.name ?? r.id) },
      },
      { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
      { name: 'valid_from', label: 'Valid from', type: 'datetime', nullable: true },
      { name: 'valid_until', label: 'Valid until', type: 'datetime', nullable: true },
      { name: 'max_devices', label: 'Max devices', type: 'number', min: 1, nullable: true },
      {
        name: 'auth_methods',
        label: 'Authentication methods',
        type: 'list',
        hint: 'Comma-separated: password, mac, voucher, idp.',
      },
    ],
    headerActions: ({ orgId, refresh }) =>
      can(me, 'user:create', { organizationId: orgId, anySite: true }) ? (
        <ImportUsers orgId={orgId} onDone={refresh} />
      ) : null,
  };
  return <ResourcePage config={config} />;
}
