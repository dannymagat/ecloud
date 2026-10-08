import { LogOut, Menu, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useMatch, useNavigate } from 'react-router';
import type { NavItem } from '../lib/nav';
import { visibleOrgNav, visiblePlatformNav } from '../lib/nav';
import { useAuth } from '../lib/auth';
import { useOrganizations } from '../lib/org';
import { applyTheme, readTheme, type ThemeChoice } from '../lib/theme';
import { Button, cx } from '../components/ui';
import { ImpersonationBanner } from './ImpersonationBanner';

function NavSection({
  title,
  base,
  items,
  onNavigate,
}: {
  title: string;
  base: string;
  items: NavItem[];
  onNavigate: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-subtle">
        {title}
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.path}>
            <NavLink
              to={`${base}/${item.path}`}
              onClick={onNavigate}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary',
                  isActive ? 'bg-primary/10 font-medium text-primary' : 'text-fg hover:bg-muted',
                )
              }
            >
              <item.icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Shell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const orgMatch = useMatch('/orgs/:orgId/*');
  const orgId = orgMatch?.params.orgId ?? null;
  const { options } = useOrganizations(me);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => applyTheme(theme), [theme]);

  const impersonation = me?.kind === 'admin' ? me.impersonation : null;
  const orgNav = orgId ? visibleOrgNav(me, orgId) : [];
  const platformNav = visiblePlatformNav(me);
  const orgName = (id: string | null) => options.find((o) => o.id === id)?.name;
  const isDark = document.documentElement.classList.contains('dark');

  const switchOrg = (id: string) => {
    if (!id) return;
    const rest = orgMatch?.params['*']?.split('/')[0] ?? 'dashboard';
    void navigate(`/orgs/${id}/${rest || 'dashboard'}`);
  };

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      {impersonation ? (
        <ImpersonationBanner
          impersonation={impersonation}
          organizationName={orgName(impersonation.organization_id)}
        />
      ) : null}
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur print:hidden">
        <div className="flex items-center gap-3 px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            aria-label="Toggle navigation"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </Button>
          <span className="font-semibold tracking-tight">ECLOUD</span>
          {options.length > 0 && !impersonation ? (
            <label className="ml-2 flex min-w-0 items-center gap-2 text-sm">
              <span className="sr-only sm:not-sr-only sm:text-subtle">Organization</span>
              <select
                className="min-w-0 max-w-[12rem] rounded-md border border-border bg-surface px-2 py-1 text-sm sm:max-w-xs"
                value={orgId ?? ''}
                onChange={(e) => switchOrg(e.target.value)}
              >
                <option value="">Select…</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={() => setTheme(isDark ? 'light' : 'dark')}
            >
              {isDark ? (
                <Sun className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Moon className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
            <span className="hidden text-sm text-subtle md:inline">
              {me?.kind === 'admin' ? me.administrator.email : 'API key'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Sign out"
              onClick={() => {
                void logout().then(() => navigate('/login'));
              }}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      <div className="flex flex-1">
        <nav
          id="primary-nav"
          aria-label="Primary"
          className={cx(
            'w-60 shrink-0 border-r border-border bg-surface px-2 pb-6 print:hidden',
            'fixed inset-y-0 left-0 z-20 mt-[49px] overflow-y-auto lg:static lg:mt-0 lg:block',
            menuOpen ? 'block' : 'hidden',
          )}
        >
          {orgId ? (
            <NavSection
              title={orgName(orgId) ?? 'Organization'}
              base={`/orgs/${orgId}`}
              items={orgNav}
              onNavigate={() => setMenuOpen(false)}
            />
          ) : null}
          <NavSection
            title="Platform"
            base="/platform"
            items={platformNav}
            onNavigate={() => setMenuOpen(false)}
          />
        </nav>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
