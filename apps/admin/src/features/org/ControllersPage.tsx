/**
 * Vendor controllers + their controller-API credential (Cycle A, D-044; migration 028).
 *
 * The API credential is write-only: the form sets or rotates it as a whole (the secret is
 * always re-entered) and the page only ever shows metadata (`has_secret`, rotation time). No
 * outbound call is made with it in Cycle A; base URLs pass the server-side SSRF guard.
 *
 * Cycle D (migration 031): per-adapter settings (UniFi site name, Omada CONTROLLER_ID, Mist
 * portal host + WLAN ids), TLS pinning for on-prem self-signed controllers (CA PEM or SHA-256
 * fingerprint; there is no "insecure" option) and a permission-gated, audited "Test connection"
 * (`controller:update`) whose outcome is a code, never vendor text.
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
  {
    name: 'external_site_id',
    label: 'Vendor site id',
    type: 'text',
    hint: 'UniFi: the Network API site id (needed before ECLOUD can call the controller).',
  },
  {
    name: 'unifi_site_name',
    label: 'UniFi site name (redirect path)',
    type: 'text',
    placeholder: 'default',
    hint: 'UniFi only: the <site> in /guest/s/<site>/; when set, redirects for other sites are refused.',
  },
  {
    name: 'omada_controller_id',
    label: 'Omada CONTROLLER_ID',
    type: 'text',
    hint: 'Omada only: the controller id path segment of https://CONTROLLER:PORT/CONTROLLER_ID/.',
  },
  {
    name: 'mist_portal_host',
    label: 'Mist portal host',
    type: 'text',
    placeholder: 'portal.mist.com',
    hint: 'Mist only: portal.mist.com or portal.<region>.mist.com.',
  },
  {
    name: 'mist_wlan_ids',
    label: 'Mist guest WLAN ids',
    type: 'list',
    hint: 'Mist only: the WLAN UUIDs whose API secret this is; redirects for other WLANs are refused.',
  },
  {
    name: 'tls_fingerprint_sha256',
    label: 'Pinned TLS fingerprint (SHA-256)',
    type: 'text',
    hint: 'On-prem self-signed controller: the SHA-256 fingerprint of its certificate. Leave empty to use the system CAs or a pinned CA.',
  },
  {
    name: 'tls_ca_pem',
    label: 'Pinned CA certificate (PEM)',
    type: 'textarea',
    hint: 'Optional private CA for the controller certificate (certificate only, never a key). TLS is always verified.',
  },
];

/** Form fields that the API expects inside `settings` (not top-level). */
export const SETTINGS_FIELDS = [
  'unifi_site_name',
  'omada_controller_id',
  'mist_portal_host',
  'mist_wlan_ids',
] as const;

/** Flat form body → API body (`settings` object for the per-adapter fields). */
export function credentialBody(flat: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    if ((SETTINGS_FIELDS as readonly string[]).includes(k)) settings[k] = v;
    else body[k] = v;
  }
  body.settings = settings;
  return body;
}

function TestConnection({ orgId, id, onDone }: { orgId: string; id: string; onDone: () => void }) {
  const test = useMutation({
    mutationFn: () =>
      api('post', '/api/v1/orgs/{orgId}/controllers/{id}/api-credential/test', {
        params: { orgId, id },
      }),
    onSuccess: onDone,
  });
  const result = test.data;
  return (
    <div className="space-y-2">
      <Button size="sm" busy={test.isPending} onClick={() => test.mutate()}>
        Test connection
      </Button>
      <ProblemAlert error={test.error} />
      {result ? (
        <p role="status">
          <Badge tone={result.ok ? 'success' : 'danger'}>{result.ok ? 'ok' : result.code}</Badge>{' '}
          {result.detail}
          {result.contacted ? '' : ' (no network call was made)'}
        </p>
      ) : null}
    </div>
  );
}

function ApiCredential({ row, orgId, canTest }: { row: Row; orgId: string; canTest: boolean }) {
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
              <p className="mt-1 text-slate-600 dark:text-slate-300">
                TLS: {meta.tls_trust} · last test:{' '}
                {meta.last_test_at
                  ? `${display(meta.last_test_result)} (${formatDateTime(meta.last_test_at)})`
                  : 'never'}{' '}
                · AP inventory:{' '}
                {meta.inventory_checked_at
                  ? `${display(meta.inventory_result)}, ${display(meta.inventory_matched)} verified`
                  : 'not run'}
              </p>
              {canTest ? (
                <div className="mt-2">
                  <TestConnection
                    orgId={orgId}
                    id={id}
                    onDone={() => void qc.invalidateQueries({ queryKey })}
                  />
                </div>
              ) : null}
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
                    tls_fingerprint_sha256: meta.tls_fingerprint_sha256,
                    ...meta.settings,
                  }
                : { base_url: row.base_url }
            }
            submitLabel={meta ? 'Rotate credential' : 'Set credential'}
            busy={save.isPending}
            problem={save.error ? problemOf(save.error) : null}
            onSubmit={(values) =>
              save.mutate(credentialBody(toBody(credentialFields, values, 'create')))
            }
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
      hint: 'https only. ECLOUD calls the controller only through the API credential below (SSRF-guarded, TLS verified).',
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
      'Vendor controllers (UniFi, Omada, Mist, Ruckus, Meraki, ...). The controller API credential is write-only; UniFi and Omada are called through the SSRF-guarded client, Mist grants are signed locally (Cycle D).',
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
        <ApiCredential
          row={row}
          orgId={orgId}
          canTest={can(me, 'controller:update', {
            organizationId: orgId,
            siteId: (row.site_id as string | null) ?? null,
          })}
        />
      ) : null,
  };
  return <ResourcePage config={config} />;
}
