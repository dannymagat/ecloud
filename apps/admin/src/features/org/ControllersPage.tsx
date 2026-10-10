/**
 * Vendor controllers + their controller-API credential (Cycle A, D-044; migration 028).
 *
 * The API credential is write-only: the form sets or rotates it as a whole (the secret is
 * always re-entered) and the page only ever shows metadata (`has_secret`, rotation time). No
 * outbound call is made with it in Cycle A; base URLs pass the server-side SSRF guard.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, newIdempotencyKey } from '../../api/client';
import { problemOf } from '../../api/problem';
import type { Row } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Badge, Button } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { display, formatDateTime, str } from '../../lib/format';
import { can } from '../../lib/permissions';
import { toBody, type FieldDef } from '../resource/form';
import { ResourceForm } from '../resource/ResourceForm';
import { ResourcePage, type ResourceConfig } from '../resource/ResourcePage';

/** Controller-API kinds (server: VENDOR_API_KINDS) and the vendor each needs. */
export const API_KINDS = [
  { value: 'unifi-network', label: 'UniFi Network API (API key)', vendor: 'ubiquiti-unifi' },
  { value: 'omada-controller', label: 'Omada controller (operator)', vendor: 'tplink-omada' },
  { value: 'mist', label: 'Juniper Mist (API token / WLAN secret)', vendor: 'juniper-mist' },
  { value: 'ruckus-nbi', label: 'Ruckus SmartZone / ZD NBI', vendor: 'ruckus' },
  { value: 'ruckus-one', label: 'Ruckus One', vendor: 'ruckus' },
  { value: 'meraki-dashboard', label: 'Meraki Dashboard (API key)', vendor: 'cisco-meraki' },
] as const;

const VENDOR_OPTIONS = [
  { value: 'ubiquiti-unifi', label: 'Ubiquiti UniFi' },
  { value: 'tplink-omada', label: 'TP-Link Omada' },
  { value: 'juniper-mist', label: 'Juniper Mist' },
  { value: 'ruckus', label: 'Ruckus' },
  { value: 'cisco-meraki', label: 'Cisco Meraki' },
  { value: 'cambium', label: 'Cambium Networks' },
  { value: 'ezelink', label: 'EzeLink (EZE controller)' },
];

const KIND_OPTIONS = [
  { value: 'on_premises', label: 'On premises (private address allowed)' },
  { value: 'cloud', label: 'Cloud (public host only)' },
  { value: 'embedded', label: 'Embedded (on the gateway / AP)' },
];

export const credentialFields: FieldDef[] = [
  {
    name: 'api_kind',
    label: 'API',
    type: 'select',
    required: true,
    options: API_KINDS.map((k) => ({ value: k.value, label: k.label })),
  },
  {
    name: 'base_url',
    label: 'API base URL',
    type: 'text',
    required: true,
    placeholder: 'https://controller.example:8443/',
    hint: 'https only, no user:password@, no #fragment. Cloud controllers need a public host; loopback, link-local and metadata addresses are refused.',
  },
  {
    name: 'username',
    label: 'Username / client id',
    type: 'text',
    hint: 'Required for Omada (operator name); optional otherwise.',
  },
  {
    name: 'secret',
    label: 'Secret (API key / password)',
    type: 'password',
    required: true,
    hint: 'Write-only: sealed at rest and never shown again. Re-enter it to change any field.',
  },
  { name: 'external_org_id', label: 'Vendor org / controller id', type: 'text' },
  { name: 'external_site_id', label: 'Vendor site id', type: 'text' },
];

function ApiCredential({ row, orgId }: { row: Row; orgId: string }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const qc = useQueryClient();
  const id = str(row.id);
  const queryKey = ['org', orgId, 'controller-api-credential', id];
  const current = useQuery({
    queryKey,
    enabled: open,
    retry: false,
    queryFn: async () => {
      try {
        return await api('get', '/api/v1/orgs/{orgId}/controllers/{id}/api-credential', {
          params: { orgId, id },
        });
      } catch (error) {
        if (problemOf(error).status === 404) return null;
        throw error;
      }
    },
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('post', '/api/v1/orgs/{orgId}/controllers/{id}/api-credential', {
        params: { orgId, id },
        body: body as never,
        idempotencyKey: key,
      }),
    onSuccess: () => {
      setKey(newIdempotencyKey());
      void qc.invalidateQueries({ queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      api('delete', '/api/v1/orgs/{orgId}/controllers/{id}/api-credential', {
        params: { orgId, id },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey }),
  });
  const meta = current.data ?? null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        API credential
      </Button>
      <Dialog
        open={open}
        title={`Controller API credential: ${str(row.name ?? row.id)}`}
        onClose={() => {
          setOpen(false);
          save.reset();
          remove.reset();
        }}
      >
        <div className="space-y-4 text-sm">
          {meta ? (
            <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
              <p>
                <Badge tone="success">stored</Badge>{' '}
                <code className="text-xs">{meta.api_kind}</code> at{' '}
                <code className="text-xs">{meta.base_url}</code>
              </p>
              <p className="mt-1 text-slate-600 dark:text-slate-300">
                Username: {display(meta.username)} · org: {display(meta.external_org_id)} · site:{' '}
                {display(meta.external_site_id)} · secret rotated {formatDateTime(meta.rotated_at)}
              </p>
            </div>
          ) : current.isLoading ? (
            <p>Loading…</p>
          ) : (
            <p>No API credential is stored for this controller.</p>
          )}
          {save.isSuccess ? (
            <p role="status">Credential saved. The secret is not shown again.</p>
          ) : null}
          <ResourceForm
            key={meta?.rotated_at ?? 'new'}
            orgId={orgId}
            fields={credentialFields}
            mode="create"
            row={
              meta
                ? {
                    api_kind: meta.api_kind,
                    base_url: meta.base_url,
                    username: meta.username,
                    external_org_id: meta.external_org_id,
                    external_site_id: meta.external_site_id,
                  }
                : { base_url: row.base_url }
            }
            submitLabel={meta ? 'Rotate credential' : 'Set credential'}
            busy={save.isPending}
            problem={save.error ? problemOf(save.error) : null}
            onSubmit={(values) => save.mutate(toBody(credentialFields, values, 'create'))}
            onCancel={() => setOpen(false)}
          />
          {meta ? (
            <div className="flex justify-end">
              <ProblemAlert error={remove.error} />
              <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
                Remove credential
              </Button>
            </div>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}

export function ControllersPage() {
  const { me } = useAuth();
  const fields: FieldDef[] = [
    { name: 'name', label: 'Name', type: 'text', required: true },
    {
      name: 'vendor_key',
      label: 'Vendor',
      type: 'select',
      required: true,
      options: VENDOR_OPTIONS,
    },
    { name: 'kind', label: 'Deployment', type: 'select', required: true, options: KIND_OPTIONS },
    {
      name: 'base_url',
      label: 'Controller URL',
      type: 'text',
      required: true,
      placeholder: 'https://controller.example:8443/',
      hint: 'https only; never fetched in this release.',
    },
    {
      name: 'site_id',
      label: 'Site',
      type: 'select',
      nullable: true,
      optionsFrom: { path: '/api/v1/orgs/{orgId}/sites', label: (r) => str(r.name ?? r.id) },
      hint: 'Empty = organization-wide controller.',
    },
  ];
  const config: ResourceConfig = {
    title: 'Controllers',
    singular: 'Controller',
    description:
      'Vendor controllers (UniFi, Omada, Mist, Ruckus, Meraki, ...). The controller API credential is write-only; ECLOUD makes no call with it yet (Cycle A).',
    path: '/api/v1/orgs/{orgId}/controllers',
    siteFilter: true,
    permissions: {
      read: 'controller:read',
      create: 'controller:create',
      update: 'controller:update',
      delete: 'controller:delete',
    },
    columns: [
      { key: 'name', header: 'Name' },
      { key: 'vendor_key', header: 'Vendor' },
      { key: 'kind', header: 'Deployment' },
      {
        key: 'base_url',
        header: 'URL',
        render: (r) => <code className="text-xs">{display(r.base_url)}</code>,
      },
      { key: 'updated_at', header: 'Updated', render: (r) => formatDateTime(r.updated_at) },
    ],
    fields,
    editFields: [
      ...fields,
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        options: [
          { value: 'active', label: 'Active' },
          { value: 'disabled', label: 'Disabled' },
        ],
      },
    ],
    rowActions: (row, { orgId }) =>
      can(me, 'controller:secret:rotate', {
        organizationId: orgId,
        siteId: (row.site_id as string | null) ?? null,
      }) ? (
        <ApiCredential row={row} orgId={orgId} />
      ) : null,
  };
  return <ResourcePage config={config} />;
}
