/**
 * Access Points page (D-045): header actions (Add, Network Limits, Download MikroTik
 * installation script), the "Configure Access Points" progress card, the RADIUS Secret box,
 * the access-point table and the "How to configure your access points?" vendor grid with
 * official logos. The Add flow is a step-by-step wizard (AddAccessPointWizard).
 */
import { Download, Gauge, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { buildUrl, downloadFile, saveBlob } from '../../api/client';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, PageHeader, Spinner } from '../../components/ui';
import { RequireOrgPermission } from '../../layout/guards';
import { useAuth } from '../../lib/auth';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';
import { siteParam } from '../../lib/sites';
import { useCatalogue } from '../setup-guides/SetupGuidesPage';
import { AccessPointsTable } from './AccessPointsTable';
import { AddAccessPointWizard } from './AddAccessPointWizard';
import {
  LOGIN_HTML_PATH,
  MIKROTIK_ADAPTER,
  SCRIPT_PATH,
  useOverview,
  type OverviewNas,
} from './data';
import { RadiusSecretBox } from './RadiusSecretBox';
import { SetupProgressCard } from './SetupProgressCard';
import { VendorGrid } from './VendorGrid';

const linkButton =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3.5 py-2 text-sm font-medium text-fg hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

function MikrotikDownloads({
  orgId,
  nas,
  onClose,
}: {
  orgId: string;
  nas: readonly OverviewNas[];
  onClose: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const get = async (path: string, id: string, fallback: string) => {
    setError(null);
    try {
      const { blob, filename } = await downloadFile(
        'get',
        buildUrl(path, { orgId, id }, undefined),
      );
      saveBlob(blob, filename ?? fallback);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Dialog open title="Download MikroTik installation script" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          The RouterOS script sets the ECLOUD RADIUS server, Disconnect/CoA, the HotSpot profile and
          the walled garden. It never contains the RADIUS secret: paste it where the script says.
          Upload the generated login.html to the HotSpot html-directory.
        </p>
        <ul
          className="divide-y divide-border rounded-md border border-border"
          aria-label="MikroTik NAS"
        >
          {nas.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
              <span>
                <span className="font-medium">{n.name}</span>
                <span className="block text-xs text-subtle">{n.site_name}</span>
              </span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void get(SCRIPT_PATH, n.id, 'ecloud-mikrotik.rsc')}
                >
                  <Download aria-hidden="true" className="h-3.5 w-3.5" />
                  Script (.rsc)
                </Button>
                <Button size="sm" onClick={() => void get(LOGIN_HTML_PATH, n.id, 'login.html')}>
                  <Download aria-hidden="true" className="h-3.5 w-3.5" />
                  login.html
                </Button>
              </span>
            </li>
          ))}
        </ul>
        <ProblemAlert error={error} />
      </div>
    </Dialog>
  );
}

function Page() {
  const orgId = useOrgId();
  const { me } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const siteId = siteParam(params);
  const overview = useOverview(orgId, siteId);
  const catalogue = useCatalogue(orgId);
  const [wizard, setWizard] = useState(false);
  const [downloads, setDownloads] = useState(false);

  const target = { organizationId: orgId, anySite: true };
  const canAdd = can(me, 'nas:create', target);
  const canInvite = can(me, 'administrator:invite', { organizationId: orgId });
  const canPolicies = can(me, 'policy:read', { organizationId: orgId });
  const o = overview.data;
  const mikrotik = (o?.nas ?? []).filter((n) => n.adapter_key === MIKROTIK_ADAPTER);

  const openMikrotik = () => {
    if (mikrotik.length === 0) void navigate(`/orgs/${orgId}/setup-guides/mikrotik`);
    else setDownloads(true);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Access Points"
        actions={
          <>
            {canAdd ? (
              <Button variant="primary" onClick={() => setWizard(true)}>
                <Plus aria-hidden="true" className="h-4 w-4" />
                Add
              </Button>
            ) : null}
            {canPolicies ? (
              <Link to={`/orgs/${orgId}/policies`} className={linkButton}>
                <Gauge aria-hidden="true" className="h-4 w-4" />
                Network Limits
              </Link>
            ) : null}
            <Button onClick={openMikrotik} disabled={o === undefined}>
              <Download aria-hidden="true" className="h-4 w-4" />
              Download MikroTik installation script
            </Button>
          </>
        }
      />
      <ProblemAlert error={overview.error} />
      {overview.isPending ? (
        <div className="py-10 text-center">
          <Spinner label="Loading access points" />
        </div>
      ) : null}
      {o ? (
        <>
          <SetupProgressCard
            orgId={orgId}
            overview={o}
            canInvite={canInvite}
            canAdd={canAdd}
            onAdd={() => setWizard(true)}
          />
          <RadiusSecretBox orgId={orgId} nas={o.nas} />
          <div className="min-w-0">
            <AccessPointsTable
              orgId={orgId}
              rows={o.access_points}
              loading={false}
              error={null}
              canUpdate={can(me, 'nas:update', target)}
              canDelete={can(me, 'nas:delete', target)}
              canAdd={canAdd}
              onAdd={() => setWizard(true)}
            />
            {o.truncated ? (
              <p className="mt-2 text-xs text-subtle">
                Showing the newest 1,000 access points. Filter by site to narrow the list.
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      <section aria-labelledby="how-to-heading" className="space-y-3">
        <h2 id="how-to-heading" className="text-base font-semibold">
          How to configure your access points?
        </h2>
        <ProblemAlert error={catalogue.error} />
        {catalogue.data ? (
          <VendorGrid
            entries={catalogue.data.data}
            label="Vendor setup guides"
            hrefFor={(e) => `/orgs/${orgId}/setup-guides/${e.vendor_key}`}
          />
        ) : null}
      </section>

      {wizard && o ? (
        <AddAccessPointWizard
          open
          orgId={orgId}
          siteId={siteId}
          nas={o.nas}
          onClose={() => setWizard(false)}
        />
      ) : null}
      {downloads ? (
        <MikrotikDownloads orgId={orgId} nas={mikrotik} onClose={() => setDownloads(false)} />
      ) : null}
    </div>
  );
}

export function AccessPointsPage() {
  return (
    <RequireOrgPermission permission="nas:read">
      <Page />
    </RequireOrgPermission>
  );
}
