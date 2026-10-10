/**
 * Setup-guide gallery payloads (multi-vendor Cycle F; API `GET /api/v1/orgs/{orgId}/setup-guides`
 * and `…/setup-guides/{vendorKey}`). Mirrors the API zod schemas; no secret is ever part of
 * them (secret placeholders stay `<…>` and are flagged `secret: true`).
 */
import type { Tone } from '../../components/ui';

export type GalleryFamily =
  'uam' | 'router-hotspot' | 'external-portal' | 'cloud-splash' | 'controller-api' | 'radius-8021x';

export type GalleryStatus = 'tested_on_device' | 'documented' | 'generic_profile';

export interface CatalogueEntry {
  vendor_key: string;
  display_name: string;
  product_line: string;
  adapter_key: string;
  profile: string | null;
  family: GalleryFamily;
  family_label: string;
  status: GalleryStatus;
  status_label: string;
  lifecycle: string | null;
}

export interface Catalogue {
  data: CatalogueEntry[];
  families: { key: GalleryFamily; label: string }[];
}

export interface GuideStep {
  id: string;
  title: string;
  setting: string;
  value: string;
  evidence: string[];
  secret: boolean;
}

export interface VendorGuide extends CatalogueEntry {
  site: { id: string; name: string } | null;
  portal_url: string | null;
  walled_garden: string[];
  radius: { address: string | null; auth_port: number; acct_port: number; coa_port: number } | null;
  preflight: string[];
  vendor_notes: string[];
  steps: GuideStep[];
  warnings: { code: string; message: string }[];
  secret_note: string;
  add_nas: { adapter_key: string; profile: string | null };
  meraki: {
    enabled: boolean;
    state: 'disabled' | 'enabled_missing_source_cidrs' | 'enabled_missing_port_range' | 'enabled';
    message: string;
    source_cidrs: string[];
    port_range: { min: number; max: number } | null;
    das_port: number;
    radius_reachable_from_meraki: 'no' | 'unverified';
  } | null;
}

/** Status pill tone: only device-tested evidence is green. */
export const STATUS_TONE: Readonly<Record<GalleryStatus, Tone>> = {
  tested_on_device: 'success',
  documented: 'info',
  generic_profile: 'warning',
};

/** `/orgs/:orgId/nas` with the create form open and the adapter / profile preselected. */
export function addNasHref(
  orgId: string,
  add: { adapter_key: string; profile: string | null },
  siteId: string | null,
): string {
  const q = new URLSearchParams({ new: '1', adapter_key: add.adapter_key });
  if (add.profile !== null) q.set('profile', add.profile);
  if (siteId !== null) q.set('site_id', siteId);
  return `/orgs/${encodeURIComponent(orgId)}/nas?${q.toString()}`;
}
