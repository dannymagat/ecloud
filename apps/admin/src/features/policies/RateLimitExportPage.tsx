/**
 * uCentral SSID rate-limit fragment export (Phase 7 P7-B AC2): preview and download the
 * `interfaces[].ssids[].rate-limit` fragment of a site's baseline policy for the
 * `openwifi-config` adapter. EXPORT ONLY: ECLOUD never pushes it to the EZE controller in
 * Phase 7; an operator applies it out of band. The values are source-verified, not lab
 * validated (DT-02 pending), and the screen says so.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { buildUrl, request } from '../../api/client';
import { AmberFlag } from '../../components/AmberFlag';
import { DataTable } from '../../components/DataTable';
import { ProblemAlert } from '../../components/ProblemAlert';
import { StatusBadge } from '../../components/StatusBadge';
import {
  Badge,
  Button,
  Card,
  Notice,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
} from '../../components/ui';
import { Unavailable } from '../../components/Unavailable';
import { RequireOrgPermission } from '../../layout/guards';
import { fieldLabel } from '../../lib/adapterStatus';
import { hasOperation, useApiDocument } from '../../lib/apiDoc';
import { useAuth } from '../../lib/auth';
import {
  RATE_LIMIT_FRAGMENT_PATH,
  showDeviceEnforced,
  type RateLimitFragmentExport,
} from '../../lib/enforcement';
import { display, str } from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';
import { useOptions } from '../resource/useOptions';

/** uCentral `interface.ssid.name`: 1..32 characters. */
export function ssidError(ssid: string): string | undefined {
  const t = ssid.trim();
  if (t === '') return undefined;
  return t.length > 32 ? 'An SSID name has at most 32 characters.' : undefined;
}

export function fragmentDownloadUrl(orgId: string, siteId: string, ssid: string): string {
  return buildUrl(RATE_LIMIT_FRAGMENT_PATH, { orgId, siteId }, { ssid, download: '1' });
}

function Result({
  data,
  orgId,
  siteId,
}: {
  data: RateLimitFragmentExport;
  orgId: string;
  siteId: string;
}) {
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="info">Export / preview only — not pushed</Badge>
        {data.validation?.valid ? (
          <Badge
            tone="success"
            title={`${data.validation.schema_id} sha256 ${data.validation.schema_sha256}`}
          >
            uCentral schema valid
          </Badge>
        ) : null}
        <span className="text-subtle">
          Policy {str(data.resolution.policy_id ?? 'none')} · version{' '}
          {display(data.resolution.policy_version)} · decision {display(data.resolution.decision)}
        </span>
      </p>
      {!data.available ? (
        <Notice tone="warning" title="No rate-limit fragment for this site">
          {data.reason}
        </Notice>
      ) : (
        <>
          <Card
            title={`Fragment for SSID “${data.ssid}”`}
            actions={
              <a
                href={fragmentDownloadUrl(orgId, siteId, data.ssid)}
                download
                className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-xs font-medium text-primary hover:bg-muted"
              >
                Download fragment
              </a>
            }
          >
            <pre
              className="overflow-x-auto rounded-md bg-muted p-3 text-xs"
              data-testid="fragment-json"
            >
              {JSON.stringify(data.fragment, null, 2)}
            </pre>
          </Card>
          <DataTable
            caption="Fragment values"
            rows={data.changes}
            rowKey={(c) => c.path}
            columns={[
              { key: 'field', header: 'Field', render: (c) => fieldLabel(c.field) },
              {
                key: 'path',
                header: 'uCentral key',
                render: (c) => <code className="text-xs">{c.path}</code>,
              },
              { key: 'value', header: 'Mbit/s', render: (c) => display(c.value) },
              {
                key: 'status',
                header: 'Status',
                render: (c) => (
                  <StatusBadge
                    status={c.status}
                    evidence={c.evidence}
                    evidenceLevel={c.evidence_level}
                    mode="preview"
                  />
                ),
              },
              {
                key: 'device_enforced',
                header: 'Device enforced',
                render: (c) =>
                  showDeviceEnforced(c.device_enforced, c.status, c.evidence_level) ? (
                    'Yes'
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      No <AmberFlag status="REQUIRES_DEVICE_TEST" />
                    </span>
                  ),
              },
            ]}
          />
        </>
      )}
      {data.warnings.length > 0 ? (
        <Notice tone="warning" title="Before applying">
          <ul className="list-disc pl-5">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {data.omitted.length > 0 ? (
        <Notice tone="info" title="Not in this fragment">
          <ul className="list-disc pl-5">
            {data.omitted.map((o) => (
              <li key={`${o.field}:${o.path ?? ''}`}>
                {fieldLabel(o.field)}
                {o.path ? (
                  <>
                    {' '}
                    (<code className="text-xs">{o.path}</code>)
                  </>
                ) : null}
                : {o.reason}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}

function Screen() {
  const orgId = useOrgId();
  const { me } = useAuth();
  const doc = useApiDocument();
  const available = hasOperation(doc.data, 'get', RATE_LIMIT_FRAGMENT_PATH);
  const [siteId, setSiteId] = useState('');
  const [ssid, setSsid] = useState('');
  const [submitted, setSubmitted] = useState<{ siteId: string; ssid: string } | null>(null);
  const sites = useOptions(orgId, {
    path: '/api/v1/orgs/{orgId}/sites',
    label: (r) => str(r.name ?? r.id),
  });
  const result = useQuery({
    queryKey: ['org', orgId, 'rate-limit-fragment', submitted?.siteId, submitted?.ssid],
    enabled: submitted !== null,
    queryFn: ({ signal }) =>
      request<RateLimitFragmentExport>(
        'get',
        buildUrl(
          RATE_LIMIT_FRAGMENT_PATH,
          { orgId, siteId: submitted!.siteId },
          { ssid: submitted!.ssid },
        ),
        { signal, pathTemplate: RATE_LIMIT_FRAGMENT_PATH },
      ),
  });
  const error = ssidError(ssid);
  const allowedFor = (site: string) =>
    can(me, 'policy:preview', { organizationId: orgId, siteId: site || null });

  return (
    <div>
      <PageHeader
        title="SSID rate-limit export"
        description="uCentral config fragment (openwifi-config) for a site's baseline download/upload rate. ECLOUD does not push it to the controller: download it and apply it through the EZE controller."
      />
      {doc.isPending ? (
        <Spinner label="Loading…" />
      ) : !available ? (
        <Unavailable endpoint={`GET ${RATE_LIMIT_FRAGMENT_PATH}`} />
      ) : (
        <div className="space-y-4">
          <Card>
            <form
              className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                if (siteId === '' || ssid.trim() === '' || error) return;
                setSubmitted({ siteId, ssid: ssid.trim() });
              }}
            >
              <SelectField
                label="Site"
                options={sites.data ?? []}
                placeholder="— choose a site —"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
              />
              <TextField
                label="SSID name"
                value={ssid}
                maxLength={64}
                error={error}
                onChange={(e) => setSsid(e.target.value)}
              />
              <Button
                type="submit"
                variant="primary"
                disabled={siteId === '' || ssid.trim() === '' || !!error || !allowedFor(siteId)}
                busy={result.isFetching}
              >
                Preview fragment
              </Button>
            </form>
            {siteId !== '' && !allowedFor(siteId) ? (
              <p className="mt-2 text-xs text-subtle">
                Requires <code>policy:preview</code> on this site.
              </p>
            ) : null}
          </Card>
          {result.error ? <ProblemAlert error={result.error} /> : null}
          {result.data && submitted ? (
            <Result data={result.data} orgId={orgId} siteId={submitted.siteId} />
          ) : null}
        </div>
      )}
    </div>
  );
}

export function RateLimitExportPage() {
  return (
    <RequireOrgPermission permission="policy:preview">
      <Screen />
    </RequireOrgPermission>
  );
}
