/**
 * The NAS state list (NAS_PENDING_ADOPTION_REQUIREMENTS.md §5, §6).
 *
 * The case worth protecting is the last one: a NAS that is ACTIVE and running on a platform
 * default still shows the advisory. A Pending-only surface would hide exactly that row, and at
 * the fallback's limits no guest ever complains, so this badge is the only signal a forgotten
 * access point produces.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NasStateList } from './NasStateList';

/** No adopt button mounts in these cases (every fixture is adopted), so no providers are needed. */
const ORG = '01900000-0000-7000-8000-00000000000a';
import type { OverviewNas } from './data';

const base: OverviewNas = {
  id: 'n1',
  name: 'Lobby NAS',
  site_id: 's1',
  site_name: 'Head office',
  adapter_key: 'ezeap-uam',
  vendor_key: 'ezelink',
  vendor_name: 'EZELINK',
  nas_ip: '10.0.0.2',
  status: 'active',
  has_secret: true,
  activity: 'quiet',
  last_activity_at: null,
  access_points: 1,
  state: 'active',
  pending_reasons: [],
  primary_reason: null,
  advisories: [],
  policy_evaluated: true,
  is_adopted: true,
  block_reason: null,
};

const row = (over: Partial<OverviewNas> = {}): OverviewNas => ({ ...base, ...over });

describe('NasStateList', () => {
  it('renders nothing when there are no NAS', () => {
    const { container } = render(<NasStateList orgId={ORG} rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the state of an ordinary active NAS and no count', () => {
    render(<NasStateList orgId={ORG} rows={[row()]} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByText(/not serving new connections/)).not.toBeInTheDocument();
  });

  it('counts the NAS that are not serving, in the heading', () => {
    render(
      <NasStateList
        orgId={ORG}
        rows={[
          row(),
          row({ id: 'n2', state: 'pending', primary_reason: 'NOT_ADOPTED' }),
          row({ id: 'n3', state: 'blocked', block_reason: 'suspected spoofed identifier' }),
        ]}
      />,
    );
    expect(screen.getByText('2 of 3 not serving new connections')).toBeInTheDocument();
  });

  it('shows the primary reason for a Pending NAS', () => {
    render(
      <NasStateList orgId={ORG} rows={[row({ state: 'pending', primary_reason: 'NO_POLICY' })]} />,
    );
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText(/No applicable policy/)).toBeInTheDocument();
  });

  it('prefers the operator block reason over the generic label', () => {
    render(
      <NasStateList
        orgId={ORG}
        rows={[row({ state: 'blocked', block_reason: 'replaced by AP1832' })]}
      />,
    );
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText(/replaced by AP1832/)).toBeInTheDocument();
  });

  it('shows the platform-default advisory on an ACTIVE row', () => {
    // The whole reason this list shows every NAS rather than only the Pending ones.
    render(
      <NasStateList orgId={ORG} rows={[row({ advisories: ['ON_PLATFORM_DEFAULT_PORTAL'] })]} />,
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Default portal')).toBeInTheDocument();
  });

  it('shows both defaults, and says when the policy was not evaluated', () => {
    render(
      <NasStateList
        orgId={ORG}
        rows={[
          row({
            advisories: ['ON_PLATFORM_DEFAULT_POLICY', 'ON_PLATFORM_DEFAULT_PORTAL'],
            policy_evaluated: false,
          }),
        ]}
      />,
    );
    expect(screen.getByText('Default policy')).toBeInTheDocument();
    expect(screen.getByText('Default portal')).toBeInTheDocument();
    // An active row with an unevaluated policy is "nothing else is wrong", not "fine".
    expect(screen.getByText('Policy not checked')).toBeInTheDocument();
  });
});
