/**
 * Captive-portal login-method registry, template catalogue and published-snapshot shape
 * (CAPTIVE_PORTAL_ONLY_REQUIREMENTS.md §3-§5, §8, §15).
 *
 * Why a registry rather than a union in the renderer: before this file, adding one login method
 * meant editing the portal renderer, the portal routes, the API identify handler, the database
 * CHECK and the admin page, because `PortalMethod` was a closed three-value union in
 * `apps/portal/src/pages.ts` and `PORTAL_METHODS` a hard-coded tuple in the API. The registry
 * makes a method a data row: its route segment, its dependencies, and whether it establishes
 * verified identity all live here, and the renderer, the routes and the designer read them.
 *
 * Browser-safe (no Node imports): the admin app imports it through
 * `@ecloud/shared/portal-methods`, as it already does for `portal-theme`.
 *
 * Persistence: `captive_portals.auth_methods` holds the enabled keys, `method_order` their display
 * order and `template_key` the template (migration 038). `portal_versions.snapshot` holds a
 * {@link PortalSnapshot}.
 */
import {
  PORTAL_LOGIN_METHODS,
  type PortalLoginMethod,
  type PortalStringKey,
} from './portal-theme.js';

// ---------------------------------------------------------------------------------------------
// Dependencies a method needs before a guest may be shown it
// ---------------------------------------------------------------------------------------------

/**
 * External configuration a method cannot work without. §5: "Only show a login method to guests
 * when its required configuration and location eligibility are satisfied. The administrator
 * should see why other methods are unavailable." Each value is one such reason.
 */
export const PORTAL_DEPENDENCIES = [
  'mailer',
  'sms_provider',
  'identity_provider',
  'pms_adapter',
  'payment_provider',
] as const;
export type PortalDependency = (typeof PORTAL_DEPENDENCIES)[number];

/** Which dependencies the deployment currently satisfies, resolved server-side per portal. */
export type PortalCapabilities = Readonly<Record<PortalDependency, boolean>>;

export const NO_PORTAL_CAPABILITIES: PortalCapabilities = Object.freeze({
  mailer: false,
  sms_provider: false,
  identity_provider: false,
  pms_adapter: false,
  payment_provider: false,
});

/** Human-readable reason a dependency blocks a method, for the admin designer. */
export const PORTAL_DEPENDENCY_REASON: Readonly<Record<PortalDependency, string>> = Object.freeze({
  mailer: 'No outbound mail is configured for this deployment.',
  sms_provider: 'No SMS provider is configured for this deployment.',
  identity_provider: 'No enabled identity provider is configured for this organization.',
  pms_adapter: 'No property-management-system adapter is configured for this site.',
  payment_provider: 'No payment provider is configured for this organization.',
});

// ---------------------------------------------------------------------------------------------
// The methods
// ---------------------------------------------------------------------------------------------

export const PORTAL_METHOD_KEYS = [
  'click_through',
  'password',
  'voucher',
  'email_otp',
  'sms_otp',
  'registration',
  'social',
  'sso',
  'sponsor',
  'hotel',
  'paid',
  'mac',
  'idp',
] as const;
export type PortalMethodKey = (typeof PORTAL_METHOD_KEYS)[number];

export interface PortalMethodSpec {
  readonly key: PortalMethodKey;
  /**
   * Route segment under `/f/:token/` for the method's first page, or null when the method has no
   * guest-facing page of its own (`mac` is decided by the gateway and AAA before any page).
   */
  readonly page: string | null;
  /**
   * Whether completing this method establishes a *verified* identity. §4.1 and the §17 criterion
   * "Terms/form-only access is not presented as verified identity": accepting terms or filling a
   * form proves nothing, so neither may be labelled or recorded as verification.
   */
  readonly verifiesIdentity: boolean;
  /** Dependencies that must all be satisfied before a guest may be offered the method. */
  readonly requires: readonly PortalDependency[];
  /** Theme string key for the method's button, when the operator may override the label. */
  readonly buttonStringKey: PortalStringKey | null;
  /** True for the three methods that shipped before migration 038 (used by compatibility tests). */
  readonly legacy: boolean;
}

/**
 * Registry order. This is also the fallback display order for enabled methods an operator has not
 * ordered explicitly, so it runs cheapest-for-the-guest first: one tap, then something they know,
 * then something they must receive or buy.
 */
export const PORTAL_METHODS: readonly PortalMethodSpec[] = Object.freeze([
  {
    key: 'click_through',
    page: 'click',
    verifiesIdentity: false,
    requires: [],
    buttonStringKey: 'click_through_button',
    legacy: true,
  },
  {
    key: 'password',
    page: 'login',
    verifiesIdentity: true,
    requires: [],
    buttonStringKey: 'login_button',
    legacy: true,
  },
  {
    key: 'voucher',
    page: 'voucher',
    verifiesIdentity: false,
    requires: [],
    buttonStringKey: 'voucher_button',
    legacy: true,
  },
  {
    key: 'email_otp',
    page: 'email',
    verifiesIdentity: true,
    requires: ['mailer'],
    buttonStringKey: null,
    legacy: false,
  },
  {
    key: 'sms_otp',
    page: 'sms',
    verifiesIdentity: true,
    requires: ['sms_provider'],
    buttonStringKey: null,
    legacy: false,
  },
  {
    key: 'registration',
    page: 'register',
    // A form is self-asserted data. Verification, when configured, is a separate OTP method.
    verifiesIdentity: false,
    requires: [],
    buttonStringKey: null,
    legacy: false,
  },
  {
    key: 'social',
    page: 'social',
    verifiesIdentity: true,
    requires: ['identity_provider'],
    buttonStringKey: null,
    legacy: false,
  },
  {
    key: 'sso',
    page: 'sso',
    verifiesIdentity: true,
    requires: ['identity_provider'],
    buttonStringKey: null,
    legacy: false,
  },
  {
    key: 'sponsor',
    page: 'sponsor',
    // The sponsor's decision is verified; the visitor's own identity is whatever they typed.
    verifiesIdentity: false,
    requires: ['mailer'],
    buttonStringKey: null,
    legacy: false,
  },
  {
    key: 'hotel',
    page: 'hotel',
    verifiesIdentity: true,
    requires: ['pms_adapter'],
    buttonStringKey: null,
    legacy: false,
  },
  {
    key: 'paid',
    page: 'plans',
    verifiesIdentity: false,
    requires: ['payment_provider'],
    buttonStringKey: null,
    legacy: false,
  },
  {
    // Decided by the gateway and AAA before the browser reaches a page: no guest page exists.
    key: 'mac',
    page: null,
    verifiesIdentity: false,
    requires: [],
    buttonStringKey: null,
    legacy: false,
  },
  {
    // Migration 006's generic "an identity_providers row". Kept because production rows and the
    // email-OTP design (035) use it; new configuration should name the concrete method instead.
    key: 'idp',
    page: 'idp',
    verifiesIdentity: true,
    requires: ['identity_provider'],
    buttonStringKey: null,
    legacy: true,
  },
]);

const BY_KEY: ReadonlyMap<string, PortalMethodSpec> = new Map(
  PORTAL_METHODS.map((m) => [m.key, m]),
);

export function portalMethod(key: string): PortalMethodSpec | null {
  return BY_KEY.get(key) ?? null;
}

export function isPortalMethodKey(value: unknown): value is PortalMethodKey {
  return typeof value === 'string' && BY_KEY.has(value);
}

/** The methods that existed before the registry, for the renderer's legacy page bodies. */
export function isLegacyPortalMethod(key: string): key is PortalLoginMethod {
  return (PORTAL_LOGIN_METHODS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------------------------

export type MethodAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly missing: readonly PortalDependency[] };

/**
 * Whether a method may be offered to a guest. A method with unmet dependencies is NOT shown
 * (§5), and the unmet dependencies are returned so the designer can tell the administrator why.
 */
export function methodAvailability(
  key: string,
  capabilities: PortalCapabilities,
): MethodAvailability {
  const spec = portalMethod(key);
  if (spec === null) return { available: false, missing: [] };
  const missing = spec.requires.filter((d) => !capabilities[d]);
  return missing.length === 0 ? { available: true } : { available: false, missing };
}

/**
 * The methods to render, in order: explicitly ordered first, then the remaining enabled ones in
 * registry order, with unavailable methods and methods without a guest page dropped.
 */
export function offeredMethods(
  enabled: readonly string[],
  order: readonly string[],
  capabilities: PortalCapabilities,
): PortalMethodSpec[] {
  const enabledSet = new Set(enabled);
  const ordered = order.filter((k) => enabledSet.has(k));
  const rest = PORTAL_METHODS.map((m) => m.key).filter(
    (k) => enabledSet.has(k) && !ordered.includes(k),
  );
  const out: PortalMethodSpec[] = [];
  for (const key of [...ordered, ...rest]) {
    const spec = portalMethod(key);
    if (spec === null || spec.page === null) continue;
    if (!methodAvailability(key, capabilities).available) continue;
    if (!out.includes(spec)) out.push(spec);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Templates (§4)
// ---------------------------------------------------------------------------------------------

export const PORTAL_TEMPLATE_KEYS = [
  'quick_connect',
  'verified_guest',
  'account_access',
  'voucher_paid',
  'hotel_resident',
  'branded_multi_login',
] as const;
export type PortalTemplateKey = (typeof PORTAL_TEMPLATE_KEYS)[number];

/** §3: "Default starting template: Branded Multi-Login". */
export const DEFAULT_PORTAL_TEMPLATE: PortalTemplateKey = 'branded_multi_login';

export interface PortalTemplateSpec {
  readonly key: PortalTemplateKey;
  readonly name: string;
  readonly audience: string;
  /**
   * Methods this template is built around, used to prefill a new portal and to warn an
   * administrator whose enabled set does not include any of them. NOT a restriction: §3 requires
   * that any template may offer any configured method.
   */
  readonly suggestedMethods: readonly PortalMethodKey[];
  /**
   * Starting method set for a NEW portal on this template. §3: "with methods individually enabled
   * only after configuration. Do not enable every method automatically." So this names only
   * methods with no external dependency; everything else starts off.
   */
  readonly defaultMethods: readonly PortalMethodKey[];
  /** Whether the landing page leads with one primary action (§4.6) or a plain method list. */
  readonly primaryAction: boolean;
}

export const PORTAL_TEMPLATES: readonly PortalTemplateSpec[] = Object.freeze([
  {
    key: 'quick_connect',
    name: 'Quick Connect',
    audience: 'Cafes, public areas and simple guest access',
    suggestedMethods: ['click_through', 'mac'],
    defaultMethods: ['click_through'],
    primaryAction: true,
  },
  {
    key: 'verified_guest',
    name: 'Verified Guest',
    audience: 'Offices, visitor networks, clinics and venues',
    suggestedMethods: ['registration', 'email_otp', 'sms_otp', 'sponsor'],
    // Registration alone asserts nothing, so a new Verified Guest portal starts with the form and
    // the administrator turns on a verification method once its provider is configured.
    defaultMethods: ['registration'],
    primaryAction: true,
  },
  {
    key: 'account_access',
    name: 'Account Access',
    audience: 'Staff, residents and existing subscribers',
    suggestedMethods: ['password', 'sso'],
    defaultMethods: ['password'],
    primaryAction: true,
  },
  {
    key: 'voucher_paid',
    name: 'Voucher and Paid Access',
    audience: 'Events, guest packages and paid internet',
    suggestedMethods: ['voucher', 'paid'],
    defaultMethods: ['voucher'],
    primaryAction: true,
  },
  {
    key: 'hotel_resident',
    name: 'Hotel and Resident',
    audience: 'Hotels and accommodation',
    suggestedMethods: ['hotel', 'voucher', 'paid'],
    // Hotel validation needs a trusted source; until one is configured the portal has no method,
    // which is correct: §4.5 forbids granting access on a room number alone.
    defaultMethods: [],
    primaryAction: true,
  },
  {
    key: 'branded_multi_login',
    name: 'Branded Multi-Login',
    audience: 'Mixed users and multi-location deployments',
    suggestedMethods: [
      'click_through',
      'password',
      'voucher',
      'email_otp',
      'sms_otp',
      'social',
      'registration',
      'sponsor',
      'hotel',
    ],
    defaultMethods: ['click_through'],
    primaryAction: false,
  },
]);

const TEMPLATE_BY_KEY: ReadonlyMap<string, PortalTemplateSpec> = new Map(
  PORTAL_TEMPLATES.map((t) => [t.key, t]),
);

export function portalTemplate(key: string): PortalTemplateSpec | null {
  return TEMPLATE_BY_KEY.get(key) ?? null;
}

export function isPortalTemplateKey(value: unknown): value is PortalTemplateKey {
  return typeof value === 'string' && TEMPLATE_BY_KEY.has(value);
}

// ---------------------------------------------------------------------------------------------
// Registration form definition (§7, §15)
// ---------------------------------------------------------------------------------------------

export const REGISTRATION_FIELD_TYPES = ['text', 'email', 'phone', 'select', 'consent'] as const;
export type RegistrationFieldType = (typeof REGISTRATION_FIELD_TYPES)[number];

export interface RegistrationField {
  /** Stable key; also the form input name. `[a-z][a-z0-9_]{0,31}`. */
  readonly key: string;
  readonly type: RegistrationFieldType;
  readonly label: string;
  readonly required: boolean;
  /** `select` only: the permitted values. */
  readonly options?: readonly string[];
  /**
   * `consent` only: true marks the entry as optional marketing consent. §13 forbids preselecting
   * it or requiring it for basic access, so a marketing consent field with `required: true` is
   * rejected by validation.
   */
  readonly marketing?: boolean;
}

export const REGISTRATION_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_REGISTRATION_FIELDS = 12;

// ---------------------------------------------------------------------------------------------
// Published snapshot (§8, §15) — the shape of portal_versions.snapshot
// ---------------------------------------------------------------------------------------------

export interface PortalSnapshotTheme {
  /**
   * As stored in `portal_themes.colors`: unvalidated jsonb. `resolvePortalColors` sanitises it
   * at render time, which is also what re-applies a default a stored theme predates, so the
   * snapshot keeps the operator's raw choice rather than freezing today's defaults into it.
   */
  readonly colors: Record<string, unknown>;
  /** `{ [locale]: PortalStrings }`, as stored in `portal_themes.strings`. */
  readonly strings: Record<string, unknown>;
  readonly logo_asset_id: string | null;
  readonly custom_css: string | null;
}

/**
 * The whole public configuration a guest is served, frozen at publish time. Contains NO secret:
 * UAM secrets and provider client secrets stay in their own columns and are read per request.
 */
export interface PortalSnapshot {
  readonly template_key: string;
  readonly name: string;
  readonly methods: readonly string[];
  readonly method_order: readonly string[];
  readonly identity_provider_ids: readonly string[];
  readonly redirect_url: string | null;
  readonly terms_version: string | null;
  readonly theme: PortalSnapshotTheme | null;
  readonly locales: readonly string[];
  readonly default_locale: string;
  readonly registration_fields: readonly RegistrationField[];
}
