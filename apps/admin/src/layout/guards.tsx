import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { onSessionExpired } from '../api/client';
import { ProblemAlert } from '../components/ProblemAlert';
import { Notice, Spinner } from '../components/ui';
import { needsMfaEnrolment, signedOut, useAuth } from '../lib/auth';
import { visibleOrgNav, visiblePlatformNav } from '../lib/nav';
import { can, canPlatform, organizationIdsOf, type PermissionTarget } from '../lib/permissions';
import { useOrgId } from '../lib/org';

/** On any 401 from a data call: drop cached data and send the operator to the login page. */
export function SessionExpiryWatcher() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(
    () =>
      onSessionExpired(() => {
        signedOut(qc);
        const next = encodeURIComponent(location.pathname + location.search);
        void navigate(`/login?expired=1&next=${next}`, { replace: true });
      }),
    [qc, navigate, location.pathname, location.search],
  );
  return null;
}

export function RequireAuth() {
  const { me, loading, error } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="p-8">
        <Spinner label="Checking session…" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-8">
        <ProblemAlert error={error} />
      </div>
    );
  }
  if (!me) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (needsMfaEnrolment(me)) return <Navigate to="/mfa/enrol" replace />;
  return <Outlet />;
}

export function HomeRedirect() {
  const { me } = useAuth();
  if (me?.kind === 'admin' && me.impersonation) {
    return <Navigate to={`/orgs/${me.impersonation.organization_id}/dashboard`} replace />;
  }
  for (const id of organizationIdsOf(me)) {
    const first = visibleOrgNav(me, id)[0];
    if (first) return <Navigate to={`/orgs/${id}/${first.path}`} replace />;
  }
  const platform = visiblePlatformNav(me)[0];
  if (platform) return <Navigate to={`/platform/${platform.path}`} replace />;
  return (
    <Notice tone="warning" title="No access">
      Your account holds no role bindings yet. Ask an administrator to grant you a role.
    </Notice>
  );
}

export function Forbidden({ permission }: { permission: string }) {
  return (
    <Notice tone="warning" title="Insufficient permission">
      This screen requires <code className="font-mono">{permission}</code>.
    </Notice>
  );
}

/** Renders children only when `permission` is granted in the current organization. */
export function RequireOrgPermission({
  permission,
  children,
}: {
  permission: string;
  children: ReactNode;
}) {
  const { me } = useAuth();
  const orgId = useOrgId();
  const target: PermissionTarget = { organizationId: orgId, anySite: true };
  return can(me, permission, target) ? <>{children}</> : <Forbidden permission={permission} />;
}

export function RequirePlatformPermission({
  anyOf,
  children,
}: {
  anyOf: readonly string[];
  children: ReactNode;
}) {
  const { me } = useAuth();
  return anyOf.some((p) => canPlatform(me, p)) ? (
    <>{children}</>
  ) : (
    <Forbidden permission={anyOf.join(' or ')} />
  );
}
