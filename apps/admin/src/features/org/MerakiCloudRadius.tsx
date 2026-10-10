/**
 * Cisco Meraki cloud-sourced RADIUS in the admin UI (multi-vendor Cycle E, D-044):
 *  - `MerakiCloudRadiusNotice`: the platform state (MERAKI_CLOUD_RADIUS_ENABLED, default OFF),
 *    stated plainly. Never claims reachability ECLOUD cannot observe.
 *  - `SetupGuideButton`: the NAS setup guide from the API (non-secret values resolved, warnings
 *    first). The RADIUS secret is never shown here (it is shown once at create / rotate).
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { buildUrl, request } from '../../api/client';
import type { Row } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, Notice } from '../../components/ui';
import { useOrgId } from '../../lib/org';
import { str } from '../../lib/format';

export const MERAKI_ADAPTER_KEY = 'meraki-splash';

export interface MerakiCloudRadiusStatus {
  enabled: boolean;
  state: 'disabled' | 'enabled_missing_source_cidrs' | 'enabled_missing_port_range' | 'enabled';
  message: string;
  source_cidrs: string[];
  port_range: { min: number; max: number } | null;
  das_port: number;
  radius_reachable_from_meraki: 'no' | 'unverified';
}

export interface SetupGuide {
  nas_id: string;
  adapter_key: string | null;
  steps: { id: string; title: string; setting: string; value: string; evidence: string[] }[];
  warnings: { code: string; message: string }[];
  meraki: MerakiCloudRadiusStatus | null;
}

/** Banner text per state: the platform flag is the first thing a Meraki operator must know. */
export function merakiStatusTitle(s: MerakiCloudRadiusStatus): string {
  if (s.state === 'enabled') return 'Meraki cloud RADIUS: enabled (reachability not verified)';
  if (s.state === 'disabled') return 'Meraki cloud RADIUS: OFF — Meraki RADIUS cannot reach ECLOUD';
  return 'Meraki cloud RADIUS: enabled but incomplete — no listener is rendered';
}

export function MerakiCloudRadiusNotice() {
  const orgId = useOrgId();
  const q = useQuery({
    queryKey: ['org', orgId, 'meraki-cloud-radius'],
    retry: false,
    queryFn: () =>
      request<MerakiCloudRadiusStatus>(
        'get',
        buildUrl('/api/v1/orgs/{orgId}/meraki/cloud-radius', { orgId }, undefined),
        { pathTemplate: '/api/v1/orgs/{orgId}/meraki/cloud-radius' },
      ),
  });
  if (q.data === undefined) return null;
  return (
    <Notice
      tone={q.data.state === 'enabled' ? 'info' : 'warning'}
      title={merakiStatusTitle(q.data)}
    >
      {q.data.message} Cisco Meraki NAS can still be registered; their setup guide shows what is
      missing.
    </Notice>
  );
}

export function SetupGuideButton({ row, orgId }: { row: Row; orgId: string }) {
  const [open, setOpen] = useState(false);
  const id = str(row.id);
  const guide = useQuery({
    queryKey: ['org', orgId, 'nas-setup-guide', id],
    enabled: open,
    retry: false,
    queryFn: () =>
      request<SetupGuide>(
        'get',
        buildUrl('/api/v1/orgs/{orgId}/nas/{id}/setup-guide', { orgId, id }, undefined),
        { pathTemplate: '/api/v1/orgs/{orgId}/nas/{id}/setup-guide' },
      ),
  });
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Setup guide
      </Button>
      <Dialog
        open={open}
        title={`Setup guide: ${str(row.name ?? row.id)}`}
        onClose={() => setOpen(false)}
      >
        <div className="space-y-3 text-sm">
          <ProblemAlert error={guide.error} />
          {guide.data?.meraki ? (
            <Notice
              tone={guide.data.meraki.state === 'enabled' ? 'info' : 'warning'}
              title={merakiStatusTitle(guide.data.meraki)}
            >
              {guide.data.meraki.message}
            </Notice>
          ) : null}
          {guide.data && guide.data.warnings.length > 0 ? (
            <ul className="list-disc space-y-1 ps-5" aria-label="Warnings">
              {guide.data.warnings
                .filter((w) => !w.code.startsWith('meraki_disabled'))
                .map((w) => (
                  <li key={w.code}>{w.message}</li>
                ))}
            </ul>
          ) : null}
          {guide.data ? (
            <ol className="list-decimal space-y-2 ps-5">
              {guide.data.steps.map((s) => (
                <li key={s.id}>
                  <p className="font-medium">{s.title}</p>
                  <p className="text-subtle">
                    {s.setting}: <code className="text-xs">{s.value}</code>
                  </p>
                </li>
              ))}
            </ol>
          ) : null}
          <p className="text-subtle">
            The RADIUS shared secret is never shown here: it is displayed once when the NAS is
            created or its secret is rotated.
          </p>
        </div>
      </Dialog>
    </>
  );
}
