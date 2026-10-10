/**
 * One vendor's setup guide (multi-vendor Cycle F). Numbered steps with copy buttons for the
 * values ECLOUD fills in (portal URL, RADIUS server and ports, walled garden), honest warnings
 * (cleartext http, lab mode, Meraki OFF state, untested), a pre-flight checklist and an
 * "Add this access point" button that opens the NAS form with the adapter / profile preselected.
 * Secrets are never shown: their placeholders point to the NAS secret shown once at creation.
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { buildUrl, request } from '../../api/client';
import { CopyButton } from '../../components/CopyButton';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Badge, Button, Card, Notice, PageHeader, Spinner } from '../../components/ui';
import { RequireOrgPermission } from '../../layout/guards';
import { useAuth } from '../../lib/auth';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';
import { SITE_PARAM, siteParam } from '../../lib/sites';
import { merakiStatusTitle } from '../org/MerakiCloudRadius';
import { STATUS_TONE, addNasHref, type VendorGuide } from './types';

const PATH = '/api/v1/orgs/{orgId}/setup-guides/{vendorKey}';

/** Renders `<PLACEHOLDER>` segments distinctly so the operator sees what stays to fill in. */
export function ValueText({ value }: { value: string }) {
  const parts = value.split(/(<[^<>]+>)/g).filter((p) => p !== '');
  return (
    <>
      {parts.map((p, i) =>
        /^<[^<>]+>$/.test(p) ? (
          <span
            key={i}
            className="rounded bg-warning/10 px-1 font-semibold text-warning"
            title="Placeholder: fill in from your device or from ECLOUD"
          >
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function ValueRow({ label, value, copy = true }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="border-b border-border py-2 last:border-b-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-start justify-between gap-2">
        <code className="min-w-0 break-all font-mono text-sm">
          <ValueText value={value} />
        </code>
        {copy ? <CopyButton value={value} label={label} /> : null}
      </dd>
    </div>
  );
}

/** A value that is only a placeholder has nothing worth copying. */
export function copyable(value: string): boolean {
  return value.replace(/<[^<>]+>/g, '').trim() !== '';
}

export function EcloudValues({ guide }: { guide: VendorGuide }) {
  const rows: ReactNode[] = [];
  if (guide.portal_url !== null)
    rows.push(<ValueRow key="portal" label="Portal URL" value={guide.portal_url} />);
  if (guide.radius !== null) {
    rows.push(
      guide.radius.address === null ? (
        <ValueRow
          key="radius"
          label="RADIUS server"
          value="<ECLOUD_RADIUS_ADDRESS> (not configured)"
          copy={false}
        />
      ) : (
        <ValueRow key="radius" label="RADIUS server" value={guide.radius.address} />
      ),
      <ValueRow key="auth" label="Auth port" value={String(guide.radius.auth_port)} />,
      <ValueRow key="acct" label="Accounting port" value={String(guide.radius.acct_port)} />,
      <ValueRow key="coa" label="CoA / Disconnect port" value={String(guide.radius.coa_port)} />,
    );
  }
  rows.push(
    <ValueRow key="wg" label="Walled garden" value={guide.walled_garden.join(', ')} />,
    <div key="secret" className="flex items-start gap-2 py-2 text-sm">
      <KeyRound aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
      <p className="text-subtle">
        <span className="font-medium text-fg">Shared secret:</span> your NAS secret is shown once
        when you add the NAS (or rotate its secret). It is never part of a guide; an organization
        admin can reveal it later on the Access Points page.
      </p>
    </div>,
  );
  return (
    <Card title="ECLOUD values">
      <dl>{rows}</dl>
    </Card>
  );
}

export function Steps({ guide }: { guide: VendorGuide }) {
  return (
    <ol aria-label="Setup steps" className="space-y-3">
      {guide.steps.map((s, i) => (
        <li
          key={s.id}
          data-testid={`step-${s.id}`}
          className="flex gap-3 rounded-lg border border-border bg-surface p-3 shadow-sm sm:p-4"
        >
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-fg"
          >
            {i + 1}
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="font-medium leading-snug">
              <span className="sr-only">Step {i + 1}: </span>
              {s.title}
            </p>
            <p className="break-words text-xs text-subtle">
              Setting: <span className="font-mono">{s.setting}</span>
            </p>
            <div className="flex min-w-0 items-start justify-between gap-2 rounded-md bg-muted px-2.5 py-1.5">
              <code className="min-w-0 break-all font-mono text-sm">
                <ValueText value={s.value} />
              </code>
              {s.secret ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-subtle">
                  <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
                  Secret: shown once when you add the NAS
                </span>
              ) : copyable(s.value) ? (
                <CopyButton value={s.value} label={`value of step ${String(i + 1)}`} />
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Guide() {
  const orgId = useOrgId();
  const { vendorKey = '' } = useParams();
  const [params] = useSearchParams();
  const siteId = siteParam(params);
  const { me } = useAuth();
  const navigate = useNavigate();
  const guide = useQuery({
    queryKey: ['org', orgId, 'setup-guides', vendorKey, siteId],
    retry: false,
    queryFn: () =>
      request<VendorGuide>(
        'get',
        buildUrl(PATH, { orgId, vendorKey }, siteId === null ? undefined : { site_id: siteId }),
        { pathTemplate: PATH },
      ),
  });
  const canCreate = can(me, 'nas:create', { organizationId: orgId, anySite: true });
  const back = `/orgs/${orgId}/setup-guides${siteId === null ? '' : `?${SITE_PARAM}=${siteId}`}`;
  const g = guide.data;

  return (
    <div>
      <PageHeader
        title={g?.display_name ?? 'Setup guide'}
        subtitle={g?.product_line}
        actions={
          <>
            <Link
              to={back}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3.5 py-2 text-sm font-medium text-fg hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              All vendors
            </Link>
            {g && canCreate ? (
              <Button
                variant="primary"
                onClick={() => void navigate(addNasHref(orgId, g.add_nas, g.site?.id ?? null))}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                Add this access point
              </Button>
            ) : null}
          </>
        }
      />
      <ProblemAlert error={guide.error} />
      {guide.isPending ? (
        <div className="py-10 text-center">
          <Spinner label="Loading the setup guide" />
        </div>
      ) : null}
      {g ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{g.family_label}</Badge>
            <Badge tone={STATUS_TONE[g.status]}>{g.status_label}</Badge>
            <span className="text-xs text-subtle">
              Adapter <code>{g.adapter_key}</code>
              {g.profile !== null ? (
                <>
                  {' '}
                  · profile <code>{g.profile}</code>
                </>
              ) : null}
              {g.site !== null ? <> · site {g.site.name}</> : null}
            </span>
          </div>

          {g.meraki !== null && g.meraki.state !== 'enabled' ? (
            <Notice tone="warning" title={merakiStatusTitle(g.meraki)}>
              {g.meraki.message}
            </Notice>
          ) : null}
          {g.warnings.length > 0 ? (
            <Notice tone="warning" title="Before you rely on this guide">
              <ul className="mt-1 list-disc space-y-1 ps-5" aria-label="Warnings">
                {g.warnings
                  .filter((w) => !(g.meraki !== null && w.code === `meraki_${g.meraki.state}`))
                  .map((w) => (
                    <li key={w.code} data-code={w.code}>
                      {w.message}
                    </li>
                  ))}
              </ul>
            </Notice>
          ) : null}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <section aria-labelledby="steps-heading" className="min-w-0 space-y-3">
              <h2 id="steps-heading" className="text-base font-semibold">
                Steps
              </h2>
              <Steps guide={g} />
            </section>
            <aside className="min-w-0 space-y-4">
              <EcloudValues guide={g} />
              <Card title="Before you start">
                <ul className="list-disc space-y-1.5 ps-5 text-sm">
                  {g.preflight.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Card>
              {g.vendor_notes.length > 0 ? (
                <Card title="Vendor notes">
                  <ul className="list-disc space-y-1.5 ps-5 text-sm">
                    {g.vendor_notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </Card>
              ) : null}
              <details className="rounded-lg border border-border bg-surface p-4 text-sm shadow-sm">
                <summary className="cursor-pointer font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                  Sources
                </summary>
                <ul className="mt-2 list-disc space-y-1 ps-5 text-xs text-subtle">
                  {[...new Set(g.steps.flatMap((s) => s.evidence))].map((r) => (
                    <li key={r} className="break-words">
                      {r}
                    </li>
                  ))}
                </ul>
              </details>
            </aside>
          </div>
          <p className="text-xs text-subtle">{g.secret_note}</p>
        </div>
      ) : null}
    </div>
  );
}

export function VendorGuidePage() {
  return (
    <RequireOrgPermission permission="nas:read">
      <Guide />
    </RequireOrgPermission>
  );
}
