/**
 * EZECLOUD top bar pieces: the wordmark, the organization chip (the organization switcher), the
 * site chip (current site or "All sites", with a site picker) and the account menu.
 */
import { Building2, Check, ChevronDown, LogOut, MapPin, User } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router';
import { cx } from '../components/ui';
import { useAuth } from '../lib/auth';
import type { OrgOption } from '../lib/org';
import {
  currentSiteId,
  SITE_FILTER_PAGES,
  siteQuery,
  useSiteList,
  useSiteName,
} from '../lib/sites';
import { Popover, popoverItemClass } from './Popover';

/** The two-tone EZECLOUD letters, without a link (sign-in screens have nowhere to go "home"). */
export function WordmarkText() {
  return (
    <>
      <span className="text-brand-ink">EZE</span>
      <span className="text-primary">CLOUD</span>
    </>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      to="/"
      aria-label="EZECLOUD home"
      className={cx(
        'shrink-0 rounded text-2xl font-extrabold tracking-wide',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        className,
      )}
    >
      <WordmarkText />
    </Link>
  );
}

const chipClass =
  'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-primary/50 bg-surface px-2.5 py-1.5 text-sm text-brand-ink hover:bg-primary/10';

function ChipText({ children }: { children: string }) {
  return <span className="min-w-0 truncate">{children}</span>;
}

export function OrgChip({
  orgId,
  options,
  name,
  locked,
}: {
  orgId: string | null;
  options: OrgOption[];
  name: string | undefined;
  /** Impersonation pins one organization: the chip is not a switcher. */
  locked: boolean;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const label = orgId ? (name ?? 'Organization') : 'Select organization';
  const icon = <Building2 aria-hidden="true" className="h-4 w-4 shrink-0" />;
  if (locked || options.length === 0) {
    return orgId ? (
      <span className={cx(chipClass, 'hover:bg-surface')} title="Organization">
        {icon}
        <ChipText>{label}</ChipText>
      </span>
    ) : null;
  }
  const switchOrg = (id: string) => {
    const rest = /^\/orgs\/[^/]+\/([^/]+)/.exec(pathname)?.[1] ?? 'dashboard';
    // Detail routes (`sites/:id/dashboard`, `sessions/:id`) belong to the old organization.
    void navigate(`/orgs/${id}/${rest}`);
  };
  return (
    <Popover
      label={`Organization: ${label}`}
      panelLabel="Organizations"
      buttonClassName={chipClass}
      buttonContent={
        <>
          {icon}
          <ChipText>{label}</ChipText>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        </>
      }
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-current={o.id === orgId ? 'true' : undefined}
            className={popoverItemClass(o.id === orgId)}
            onClick={() => {
              close();
              if (o.id !== orgId) switchOrg(o.id);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{o.name}</span>
            {o.id === orgId ? <Check aria-hidden="true" className="h-4 w-4" /> : null}
          </button>
        ))
      }
    </Popover>
  );
}

export function SiteChip({ orgId }: { orgId: string }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const siteId = currentSiteId(pathname, search);
  const list = useSiteList(me, orgId);
  const siteName = useSiteName(me, orgId, siteId);
  const label = siteId ? (siteName ?? 'Selected site') : 'All sites';
  const icon = <MapPin aria-hidden="true" className="h-4 w-4 shrink-0" />;

  if (!list.enabled) {
    return (
      <span className={cx(chipClass, 'hover:bg-surface')} title="Site">
        {icon}
        <ChipText>{label}</ChipText>
      </span>
    );
  }

  const choose = (id: string | null) => {
    const segment = /^\/orgs\/[^/]+\/([^/]+)\/?$/.exec(pathname)?.[1];
    if (segment && SITE_FILTER_PAGES.includes(segment)) {
      void navigate(`/orgs/${orgId}/${segment}${siteQuery(id)}`);
    } else {
      void navigate(id ? `/orgs/${orgId}/sites/${id}/dashboard` : `/orgs/${orgId}/dashboard`);
    }
  };

  return (
    <Popover
      label={`Site: ${label}`}
      panelLabel="Sites"
      buttonClassName={chipClass}
      buttonContent={
        <>
          {icon}
          <ChipText>{label}</ChipText>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        </>
      }
    >
      {(close) => (
        <>
          <button
            type="button"
            aria-current={siteId === null ? 'true' : undefined}
            className={popoverItemClass(siteId === null)}
            onClick={() => {
              close();
              choose(null);
            }}
          >
            <span className="flex-1">All sites</span>
            {siteId === null ? <Check aria-hidden="true" className="h-4 w-4" /> : null}
          </button>
          {list.isPending ? (
            <p className="px-3 py-2 text-subtle">Loading sites…</p>
          ) : list.error ? (
            <p className="px-3 py-2 text-danger">Sites could not be loaded.</p>
          ) : (
            (list.sites ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                aria-current={s.id === siteId ? 'true' : undefined}
                className={popoverItemClass(s.id === siteId)}
                onClick={() => {
                  close();
                  choose(s.id);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                {s.id === siteId ? <Check aria-hidden="true" className="h-4 w-4" /> : null}
              </button>
            ))
          )}
        </>
      )}
    </Popover>
  );
}

export function UserMenu({ onSignOut }: { onSignOut: () => void }) {
  const { me } = useAuth();
  const who = me?.kind === 'admin' ? me.administrator.email : 'API key';
  return (
    <Popover
      label={`Account: ${who}`}
      panelLabel="Account"
      align="right"
      buttonClassName="inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-subtle hover:bg-muted hover:text-fg"
      buttonContent={
        <>
          <User aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="hidden max-w-[16rem] truncate md:inline">{who}</span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        </>
      }
    >
      {(close) => (
        <>
          <p className="border-b border-border px-3 py-2 text-xs text-subtle">
            Signed in as <span className="block truncate text-sm text-fg">{who}</span>
          </p>
          <button
            type="button"
            className={popoverItemClass()}
            onClick={() => {
              close();
              onSignOut();
            }}
          >
            <LogOut aria-hidden="true" className="h-4 w-4" />
            Sign out
          </button>
        </>
      )}
    </Popover>
  );
}
