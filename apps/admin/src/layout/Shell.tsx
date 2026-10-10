/**
 * Application shell (admin redesign cycle 1, EZECLOUD style): top bar with the wordmark,
 * organization and site chips, theme switch and account menu; grouped sidebar (a drawer below
 * the `lg` breakpoint); impersonation banner (D-027) above everything.
 */
import { Menu, Moon, Sun, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useMatch, useNavigate } from 'react-router';
import { BreadcrumbProvider } from '../components/Breadcrumb';
import { Button, cx } from '../components/ui';
import { useAuth } from '../lib/auth';
import { ORG_DASHBOARD, visibleOrgGroups, visiblePlatformGroup } from '../lib/nav';
import { useOrganizations } from '../lib/org';
import { canAny } from '../lib/permissions';
import { applyTheme, readTheme, type ThemeChoice } from '../lib/theme';
import { ImpersonationBanner } from './ImpersonationBanner';
import { Sidebar } from './Sidebar';
import { OrgChip, SiteChip, UserMenu, Wordmark } from './TopBar';

export function Shell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const orgMatch = useMatch('/orgs/:orgId/*');
  const orgId = orgMatch?.params.orgId ?? null;
  const { options } = useOrganizations(me);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => applyTheme(theme), [theme]);

  // Drawer (narrow screens): a modal dialog. Focus moves into it on open; Escape, the overlay and
  // the close button return focus to the toggle; following a link focuses the new page's heading.
  const [restoreTo, setRestoreTo] = useState<'toggle' | 'heading' | null>(null);
  const openMenu = () => {
    setRestoreTo(null);
    setMenuOpen(true);
  };
  const closeMenu = (focusTo: 'toggle' | 'heading' = 'toggle') => {
    setRestoreTo(focusTo);
    setMenuOpen(false);
  };

  useEffect(() => {
    if (!menuOpen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRestoreTo('toggle');
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // After the drawer closed (and `inert` is gone): focus the toggle or the page heading, never
  // <body>.
  useEffect(() => {
    if (menuOpen || restoreTo === null) return;
    if (restoreTo === 'heading') {
      const heading = document.querySelector<HTMLElement>('#main h1');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
        return;
      }
    }
    toggleRef.current?.focus();
  }, [menuOpen, restoreTo]);

  // A route change closes the drawer (state adjusted during render, no extra paint).
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    if (menuOpen) {
      setMenuOpen(false);
      setRestoreTo('heading');
    }
  }

  const impersonation = me?.kind === 'admin' ? me.impersonation : null;
  const target = { organizationId: orgId, anySite: true };
  const dashboard = orgId && canAny(me, ORG_DASHBOARD.anyOf, target) ? ORG_DASHBOARD : null;
  const orgGroups = orgId ? visibleOrgGroups(me, orgId) : [];
  const platformGroup = visiblePlatformGroup(me);
  const orgName = (id: string | null) => options.find((o) => o.id === id)?.name;
  const isDark = document.documentElement.classList.contains('dark');

  return (
    <BreadcrumbProvider value={{ organizationName: (id) => orgName(id) }}>
      <div className="flex min-h-screen flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        {impersonation ? (
          <div inert={menuOpen}>
            <ImpersonationBanner
              impersonation={impersonation}
              organizationName={orgName(impersonation.organization_id)}
            />
          </div>
        ) : null}
        <header
          inert={menuOpen}
          className="sticky top-0 z-30 border-b border-border bg-surface print:hidden"
        >
          <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-4">
            <Button
              ref={toggleRef}
              variant="ghost"
              size="sm"
              className="lg:hidden"
              aria-label="Toggle navigation"
              aria-expanded={menuOpen}
              aria-controls="primary-nav"
              onClick={() => (menuOpen ? closeMenu() : openMenu())}
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </Button>
            <Wordmark className="lg:w-60" />
            <div className="order-last flex w-full min-w-0 items-center gap-2 md:order-none md:w-auto md:flex-1">
              <div className="min-w-0 max-w-[50%] md:max-w-xs">
                <OrgChip
                  orgId={orgId}
                  options={options}
                  name={orgName(orgId)}
                  locked={!!impersonation}
                />
              </div>
              {orgId ? (
                <>
                  <span aria-hidden="true" className="text-primary/60">
                    ›
                  </span>
                  <div className="min-w-0 max-w-[50%] md:max-w-xs">
                    <SiteChip orgId={orgId} />
                  </div>
                </>
              ) : null}
            </div>
            <div className="ml-auto flex items-center gap-1">
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
              <UserMenu
                onSignOut={() => {
                  void logout().then(() => navigate('/login'));
                }}
              />
            </div>
          </div>
        </header>
        <div className="flex flex-1">
          {menuOpen ? (
            <div
              aria-hidden="true"
              className="fixed inset-0 z-40 bg-black/40 lg:hidden print:hidden"
              onClick={() => closeMenu()}
            />
          ) : null}
          <div
            id="primary-nav"
            role={menuOpen ? 'dialog' : undefined}
            aria-modal={menuOpen ? true : undefined}
            aria-label={menuOpen ? 'Navigation menu' : undefined}
            className={cx(
              'w-72 shrink-0 overflow-y-auto border-r border-border bg-bg print:hidden',
              'fixed inset-y-0 left-0 z-50 shadow-xl',
              'lg:sticky lg:top-14 lg:z-auto lg:block lg:h-[calc(100vh-3.5rem)] lg:w-64 lg:shadow-none',
              menuOpen ? 'block' : 'hidden',
            )}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3 lg:hidden">
              <Wordmark className="text-xl" />
              <Button
                ref={closeRef}
                variant="ghost"
                size="sm"
                aria-label="Close navigation"
                onClick={() => closeMenu()}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </div>
            <nav aria-label="Primary">
              <Sidebar
                orgId={orgId}
                dashboard={dashboard}
                orgGroups={orgGroups}
                platformGroup={platformGroup}
                onNavigate={() => {
                  if (menuOpen) closeMenu('heading');
                }}
              />
            </nav>
          </div>
          <main
            id="main"
            inert={menuOpen}
            tabIndex={-1}
            className="min-w-0 flex-1 bg-surface px-4 py-5 sm:px-6 lg:px-8"
          >
            <Outlet />
          </main>
        </div>
      </div>
    </BreadcrumbProvider>
  );
}
