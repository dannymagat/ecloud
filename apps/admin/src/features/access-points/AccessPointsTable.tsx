/**
 * "Access points" table (D-045): MAC, vendor (logo + name), name, status (verified / unverified
 * plus the NAS's observed RADIUS activity), date added and actions (edit, delete, setup guide).
 * Rows come from the overview (nas_access_points joined with the NAS adapter / vendor).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { buildUrl, request } from '../../api/client';
import { DataTable, type Column } from '../../components/DataTable';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Badge, Button, SelectField, TextField } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { ACTIVITY_LABEL, ACTIVITY_TONE, type OverviewAccessPoint } from './data';
import { VendorLogo } from './VendorLogo';

const ITEM_PATH = '/api/v1/orgs/{orgId}/access-points/{id}';

export const EMPTY_TEXT =
  "You haven't added any access points yet. Add your access points and configure the network for the login process to work.";

function EditDialog({
  orgId,
  ap,
  onClose,
}: {
  orgId: string;
  ap: OverviewAccessPoint;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(ap.name ?? '');
  const [status, setStatus] = useState(ap.status);
  const save = useMutation({
    mutationFn: () =>
      request('patch', buildUrl(ITEM_PATH, { orgId, id: ap.id }, undefined), {
        body: {
          ...(name.trim() !== (ap.name ?? '')
            ? { name: name.trim() === '' ? null : name.trim() }
            : {}),
          ...(status !== ap.status ? { status } : {}),
        },
        pathTemplate: ITEM_PATH,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['org', orgId] });
      onClose();
    },
  });
  return (
    <Dialog open title={`Edit access point ${ap.mac}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label="Name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'disabled', label: 'Disabled' },
          ]}
          hint="A disabled AP is refused by the portal (fail closed)."
        />
        <ProblemAlert error={save.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({
  orgId,
  ap,
  onClose,
}: {
  orgId: string;
  ap: OverviewAccessPoint;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () =>
      request('delete', buildUrl(ITEM_PATH, { orgId, id: ap.id }, undefined), {
        pathTemplate: ITEM_PATH,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['org', orgId] });
      onClose();
    },
  });
  return (
    <Dialog open title="Delete access point" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          Delete <code className="font-mono">{ap.mac}</code>
          {ap.name ? ` (${ap.name})` : ''}? Portal redirects naming this AP are refused afterwards.
        </p>
        <ProblemAlert error={remove.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
            Delete
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function AccessPointsTable({
  orgId,
  rows,
  loading,
  error,
  canUpdate,
  canDelete,
  canAdd,
  onAdd,
}: {
  orgId: string;
  rows: readonly OverviewAccessPoint[];
  loading: boolean;
  error: unknown;
  canUpdate: boolean;
  canDelete: boolean;
  canAdd: boolean;
  onAdd: () => void;
}) {
  const [editing, setEditing] = useState<OverviewAccessPoint | null>(null);
  const [deleting, setDeleting] = useState<OverviewAccessPoint | null>(null);

  const columns: Column<OverviewAccessPoint>[] = [
    {
      key: 'mac',
      header: 'MAC address',
      render: (r) => <code className="whitespace-nowrap font-mono text-xs">{r.mac}</code>,
    },
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) => (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <VendorLogo
            vendorKey={r.vendor_key}
            name={r.vendor_name ?? r.adapter_key ?? 'Unknown'}
            size="sm"
            decorative
          />
          <span>{r.vendor_name ?? r.adapter_key ?? '—'}</span>
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Name',
      render: (r) => (
        <span>
          {r.name ?? <span className="text-subtle">—</span>}
          <span className="block text-xs text-subtle">NAS {r.nas_name}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.verified ? (
            <Badge tone="success" title={r.verification_source ?? undefined}>
              Verified
            </Badge>
          ) : (
            <Badge tone="warning" title="Verified after its first RADIUS request">
              Unverified
            </Badge>
          )}
          <Badge tone={ACTIVITY_TONE[r.activity]} title="Observed RADIUS activity of its NAS">
            NAS: {ACTIVITY_LABEL[r.activity]}
          </Badge>
          {r.status === 'disabled' ? <Badge>Disabled</Badge> : null}
        </span>
      ),
    },
    {
      key: 'created_at',
      header: 'Date added',
      render: (r) => <span className="whitespace-nowrap">{formatDateTime(r.created_at)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <span className="flex flex-wrap gap-1">
          {canUpdate ? (
            <Button size="sm" aria-label={`Edit ${r.mac}`} onClick={() => setEditing(r)}>
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              Edit
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              aria-label={`Delete ${r.mac}`}
              onClick={() => setDeleting(r)}
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Delete
            </Button>
          ) : null}
          {r.vendor_key !== null ? (
            <Link
              to={`/orgs/${orgId}/setup-guides/${r.vendor_key}`}
              aria-label={`Setup guide for ${r.mac}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <BookOpen aria-hidden="true" className="h-3.5 w-3.5" />
              Setup guide
            </Link>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <section aria-labelledby="ap-table-heading" className="space-y-3">
      <h2 id="ap-table-heading" className="text-base font-semibold">
        Access points
      </h2>
      {!loading && rows.length === 0 && !error ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
          <p className="mx-auto max-w-xl text-sm text-subtle">{EMPTY_TEXT}</p>
          {canAdd ? (
            <Button variant="primary" className="mt-3" onClick={onAdd}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add Access Points
            </Button>
          ) : null}
        </div>
      ) : (
        <DataTable
          caption="Access points"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          error={error}
        />
      )}
      {editing !== null ? (
        <EditDialog orgId={orgId} ap={editing} onClose={() => setEditing(null)} />
      ) : null}
      {deleting !== null ? (
        <DeleteDialog orgId={orgId} ap={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </section>
  );
}
