/**
 * Grouped, collapsible, permission-driven sidebar (admin redesign cycle 1). Entries come from
 * `lib/nav` (`visibleOrgGroups`, `visiblePlatformGroup`): an entry is hidden without its
 * permission and a group without any visible entry is hidden. The group holding the current
 * route opens automatically; open/closed state is remembered per browser (localStorage,
 * best-effort).
 */
import { ChevronDown, ChevronLeft } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { cx } from '../components/ui';
import { groupKeyOf, type NavGroup, type NavItem } from '../lib/nav';

export const NAV_STATE_KEY = 'ecloud-admin-nav-groups';

type OpenState = Record<string, boolean>;

export function readNavState(): OpenState {
  try {
    const raw = localStorage.getItem(NAV_STATE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: OpenState = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'boolean') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function writeNavState(state: OpenState): void {
  try {
    localStorage.setItem(NAV_STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable (private mode): the state lasts for this page only.
  }
}

const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary';

function TopItem({ to, item, onNavigate }: { to: string; item: NavItem; onNavigate: () => void }) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          'flex items-center gap-3 border-b border-border/70 px-4 py-2.5 text-sm',
          focusRing,
          isActive ? 'bg-primary font-medium text-primary-fg' : 'text-fg hover:bg-muted',
        )
      }
    >
      <item.icon aria-hidden="true" className="h-4 w-4 shrink-0" />
      {item.label}
    </NavLink>
  );
}

function Group({
  group,
  base,
  open,
  onToggle,
  onNavigate,
}: {
  group: NavGroup;
  base: string;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const listId = useId();
  const Chevron = open ? ChevronDown : ChevronLeft;
  return (
    <li className="border-b border-border/70">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
        className={cx(
          'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-fg',
          focusRing,
          open ? 'bg-muted' : 'hover:bg-muted',
        )}
      >
        <group.icon aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        <Chevron aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
      </button>
      <ul id={listId} hidden={!open} className="pb-1.5 pt-1">
        {group.items.map((item) => (
          <li key={item.path}>
            <NavLink
              to={`${base}/${item.path}`}
              onClick={onNavigate}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2 py-1.5 pl-11 pr-4 text-sm',
                  focusRing,
                  isActive
                    ? 'font-semibold text-primary'
                    : 'text-fg hover:bg-muted hover:text-primary',
                )
              }
            >
              <span aria-hidden="true" className="text-subtle">
                ›
              </span>
              <span className="min-w-0">{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function Sidebar({
  orgId,
  dashboard,
  orgGroups,
  platformGroup,
  onNavigate,
}: {
  orgId: string | null;
  dashboard: NavItem | null;
  orgGroups: NavGroup[];
  platformGroup: NavGroup | null;
  onNavigate: () => void;
}) {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  const activeKey =
    parts[0] === 'orgs'
      ? groupKeyOf(orgGroups, parts[2])
      : parts[0] === 'platform' && platformGroup
        ? groupKeyOf([platformGroup], parts[1])
        : null;

  const [open, setOpen] = useState<OpenState>(() => {
    const stored = readNavState();
    return activeKey ? { ...stored, [activeKey]: true } : stored;
  });

  // Navigating into another group opens it (the viewer can still close it afterwards); state is
  // adjusted during render, so the group is open in the same paint as the new route.
  const [seenKey, setSeenKey] = useState(activeKey);
  if (activeKey !== seenKey) {
    setSeenKey(activeKey);
    if (activeKey && !open[activeKey]) setOpen({ ...open, [activeKey]: true });
  }

  useEffect(() => writeNavState(open), [open]);

  const toggle = (key: string) => setOpen((s) => ({ ...s, [key]: !s[key] }));

  return (
    <div className="pb-6">
      <p className="border-b border-border/70 px-4 py-3 text-xs uppercase tracking-widest text-subtle">
        Menu
      </p>
      <ul>
        {orgId && dashboard ? (
          <li>
            <TopItem
              to={`/orgs/${orgId}/${dashboard.path}`}
              item={dashboard}
              onNavigate={onNavigate}
            />
          </li>
        ) : null}
        {orgId
          ? orgGroups.map((g) => (
              <Group
                key={g.key}
                group={g}
                base={`/orgs/${orgId}`}
                open={!!open[g.key]}
                onToggle={() => toggle(g.key)}
                onNavigate={onNavigate}
              />
            ))
          : null}
      </ul>
      {platformGroup ? (
        <>
          <p className="px-4 pb-1 pt-5 text-xs uppercase tracking-widest text-subtle">
            Platform administration
          </p>
          <ul className="border-t border-border/70">
            <Group
              group={platformGroup}
              base="/platform"
              open={!!open[platformGroup.key]}
              onToggle={() => toggle(platformGroup.key)}
              onNavigate={onNavigate}
            />
          </ul>
        </>
      ) : null}
    </div>
  );
}
