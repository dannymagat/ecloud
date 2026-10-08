import { Navigate, Outlet, type RouteObject } from 'react-router';
import { AuditLogPage } from './features/audit/AuditLogPage';
import { AdministratorsPage } from './features/admins/AdministratorsPage';
import { LoginPage } from './features/auth/LoginPage';
import { MfaEnrolPage } from './features/auth/MfaEnrolPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { NasPage } from './features/org/NasPage';
import {
  ApiKeysPage,
  ClientDevicesPage,
  NetworkDevicesPage,
  PolicyAssignmentsPage,
  SitesPage,
  UserGroupsPage,
} from './features/org/resources';
import { UsersPage } from './features/org/UsersPage';
import { AdaptersPage } from './features/platform/AdaptersPage';
import { ImpersonatePage } from './features/platform/ImpersonatePage';
import { OrganizationsPage } from './features/platform/OrganizationsPage';
import { PlatformAdministratorsPage } from './features/platform/PlatformAdministratorsPage';
import { PlatformAuditPage } from './features/platform/PlatformAuditPage';
import { RoleTemplatesPage } from './features/platform/RoleTemplatesPage';
import { PoliciesPage } from './features/policies/PoliciesPage';
import { PortalDesignerPage } from './features/portals/PortalDesignerPage';
import { PortalsPage } from './features/portals/PortalsPage';
import { PolicyEditorPage } from './features/policies/PolicyEditorPage';
import { RateLimitExportPage } from './features/policies/RateLimitExportPage';
import { AccountingRecordsPage } from './features/accounting/AccountingRecordsPage';
import { SessionDetailPage } from './features/sessions/SessionDetailPage';
import { UsagePage } from './features/usage/UsagePage';
import { SessionEnforcementPage } from './features/sessions/SessionEnforcementPage';
import { SessionsPage } from './features/sessions/SessionsPage';
import { VouchersPage } from './features/vouchers/VouchersPage';
import { HomeRedirect, RequireAuth, SessionExpiryWatcher } from './layout/guards';
import { Shell } from './layout/Shell';
import { Notice } from './components/ui';

function Root() {
  return (
    <>
      <SessionExpiryWatcher />
      <Outlet />
    </>
  );
}

function NotFound() {
  return (
    <Notice tone="warning" title="Page not found">
      The address does not match any screen.
    </Notice>
  );
}

export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/mfa/enrol', element: <MfaEnrolPage /> },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <Shell />,
            children: [
              { index: true, element: <HomeRedirect /> },
              {
                path: 'orgs/:orgId',
                children: [
                  { index: true, element: <Navigate to="dashboard" replace /> },
                  { path: 'dashboard', element: <DashboardPage /> },
                  { path: 'sites', element: <SitesPage /> },
                  { path: 'network-devices', element: <NetworkDevicesPage /> },
                  { path: 'nas', element: <NasPage /> },
                  { path: 'users', element: <UsersPage /> },
                  { path: 'user-groups', element: <UserGroupsPage /> },
                  { path: 'client-devices', element: <ClientDevicesPage /> },
                  { path: 'vouchers', element: <VouchersPage /> },
                  { path: 'policies', element: <PoliciesPage /> },
                  { path: 'policies/:policyId', element: <PolicyEditorPage /> },
                  { path: 'policy-assignments', element: <PolicyAssignmentsPage /> },
                  { path: 'ssid-rate-limit-export', element: <RateLimitExportPage /> },
                  { path: 'portals', element: <PortalsPage /> },
                  { path: 'portals/:portalId', element: <PortalDesignerPage /> },
                  { path: 'sessions', element: <SessionsPage /> },
                  { path: 'sessions/:sessionId', element: <SessionDetailPage /> },
                  {
                    path: 'sessions/:sessionId/enforcement',
                    element: <SessionEnforcementPage />,
                  },
                  { path: 'usage', element: <UsagePage /> },
                  { path: 'accounting', element: <AccountingRecordsPage /> },
                  { path: 'audit-log', element: <AuditLogPage /> },
                  { path: 'administrators', element: <AdministratorsPage /> },
                  { path: 'api-keys', element: <ApiKeysPage /> },
                ],
              },
              {
                path: 'platform',
                children: [
                  { index: true, element: <HomeRedirect /> },
                  { path: 'organizations', element: <OrganizationsPage /> },
                  { path: 'administrators', element: <PlatformAdministratorsPage /> },
                  { path: 'role-templates', element: <RoleTemplatesPage /> },
                  { path: 'adapters', element: <AdaptersPage /> },
                  { path: 'audit-log', element: <PlatformAuditPage /> },
                  { path: 'impersonate', element: <ImpersonatePage /> },
                ],
              },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
    ],
  },
];
