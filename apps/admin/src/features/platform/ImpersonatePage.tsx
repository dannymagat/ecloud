import { Card, PageHeader } from '../../components/ui';
import { RequirePlatformPermission } from '../../layout/guards';
import { useAuth } from '../../lib/auth';
import { canPlatform } from '../../lib/permissions';
import { ImpersonateForm } from './ImpersonateForm';
import { usePlatformOrganizations } from './usePlatformOrgs';
import { str } from '../../lib/format';

function Screen() {
  const { me } = useAuth();
  const orgs = usePlatformOrganizations('active');
  return (
    <div className="max-w-xl">
      <PageHeader
        title="Impersonation"
        description="Act inside one organization with the support role for a limited time. Every action is audited with your identity."
      />
      <Card>
        {canPlatform(me, 'tenant:list') ? null : (
          <p className="mb-3 text-sm text-subtle">Listing organizations requires tenant:list.</p>
        )}
        <ImpersonateForm
          organizations={orgs.rows.map((r) => ({ id: r.id, name: str(r.name ?? r.id) }))}
        />
      </Card>
    </div>
  );
}

export function ImpersonatePage() {
  return (
    <RequirePlatformPermission anyOf={['tenant:impersonate']}>
      <Screen />
    </RequirePlatformPermission>
  );
}
