/**
 * Captive-portal published snapshots (CAPTIVE_PORTAL_ONLY_REQUIREMENTS.md §8, migration 038).
 *
 * Lives under `internal/` because both sides need it: the portal runtime reads the published
 * snapshot to decide what a guest is shown, and `portal-admin` writes it when an administrator
 * publishes. Putting it in `portal-admin` would make the runtime import the admin surface.
 *
 * The portal runtime used to read live `captive_portals` and `portal_themes` rows, so an
 * administrator mid-edit was visible to guests and a rollback meant reversing fields by hand.
 * Publishing freezes the whole public configuration into one immutable `portal_versions` row and
 * points `captive_portals.published_version_id` at it. That makes publishing atomic (one UPDATE
 * of one column: no half-updated configuration is reachable), rollback a pointer move, and drafts
 * unaffected by either.
 *
 * A snapshot holds no secret. UAM secrets and provider client secrets stay in their own columns
 * and are read per request; a snapshot is public configuration served to a guest's browser.
 */
import type { DbTransaction } from '@ecloud/db';
import {
  DEFAULT_PORTAL_TEMPLATE,
  MAX_REGISTRATION_FIELDS,
  REGISTRATION_FIELD_KEY_RE,
  REGISTRATION_FIELD_TYPES,
  isLegacyPortalMethod,
  methodAvailability,
  offeredMethods,
  portalMethod,
  portalTemplate,
  type PortalCapabilities,
  type PortalLoginMethod,
  type PortalSnapshot,
  type RegistrationField,
} from '@ecloud/shared';

export type { PortalSnapshot };
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Registration form definition (§7, §13)
// ---------------------------------------------------------------------------------------------

export const RegistrationFieldInput = z
  .strictObject({
    key: z.string().regex(REGISTRATION_FIELD_KEY_RE, 'lower-case key, letters/digits/underscore'),
    type: z.enum(REGISTRATION_FIELD_TYPES),
    label: z.string().trim().min(1).max(200),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(200)).min(1).max(50).optional(),
    marketing: z.boolean().optional(),
  })
  .refine((f) => f.type === 'select' || f.options === undefined, {
    message: 'options apply to a select field only',
    path: ['options'],
  })
  .refine((f) => f.type !== 'select' || f.options !== undefined, {
    message: 'a select field needs options',
    path: ['options'],
  })
  .refine((f) => f.marketing !== true || f.type === 'consent', {
    message: 'marketing applies to a consent field only',
    path: ['marketing'],
  })
  // §13: optional marketing consent is never preselected and never required for basic access.
  .refine((f) => f.marketing !== true || !f.required, {
    message: 'marketing consent must not be required for access',
    path: ['required'],
  });

export const RegistrationFieldsInput = z
  .array(RegistrationFieldInput)
  .max(MAX_REGISTRATION_FIELDS)
  .refine(
    (fields) => new Set(fields.map((f) => f.key)).size === fields.length,
    'field keys must be unique',
  );

/** Re-validates stored draft fields on the way into a snapshot (a row may predate a rule). */
function readRegistrationFields(raw: unknown): RegistrationField[] {
  const parsed = RegistrationFieldsInput.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// ---------------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------------

/**
 * Which method dependencies this deployment and organization satisfy. §5: a method whose
 * configuration is absent is not shown to guests, and the administrator is told why.
 *
 * `sms_provider`, `pms_adapter` and `payment_provider` are false until their adapters ship
 * (gap analysis §4, stages 9 and 10). They are reported as unconfigured rather than hidden, so
 * the designer can explain the gap instead of silently dropping the method.
 */
export async function portalCapabilities(
  trx: DbTransaction,
  opts: { readonly mailerConfigured: boolean },
): Promise<PortalCapabilities> {
  const idp = await trx
    .selectFrom('identity_providers')
    .select('id')
    .where('enabled', '=', true)
    .limit(1)
    .executeTakeFirst();
  return {
    mailer: opts.mailerConfigured,
    sms_provider: false,
    identity_provider: idp !== undefined,
    pms_adapter: false,
    payment_provider: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

/** The `captive_portals` + `portal_themes` columns a snapshot is built from. */
export interface PortalDraft {
  readonly name: string;
  readonly template_key: string;
  readonly auth_methods: readonly string[];
  readonly method_order: readonly string[];
  readonly identity_provider_ids: readonly string[];
  readonly redirect_url: string | null;
  readonly terms_version: string | null;
  readonly registration_fields: unknown;
  readonly locales: readonly string[];
  readonly theme: {
    readonly colors: Record<string, unknown>;
    readonly strings: Record<string, unknown>;
    readonly logo_asset_ref: string | null;
    readonly custom_css: string | null;
  } | null;
}

export function buildSnapshot(draft: PortalDraft): PortalSnapshot {
  const locales = draft.locales.length === 0 ? ['en'] : [...draft.locales];
  return {
    template_key: draft.template_key,
    name: draft.name,
    methods: [...draft.auth_methods],
    method_order: [...draft.method_order],
    identity_provider_ids: [...draft.identity_provider_ids],
    redirect_url: draft.redirect_url,
    terms_version: draft.terms_version,
    theme:
      draft.theme === null
        ? null
        : {
            colors: draft.theme.colors,
            strings: draft.theme.strings,
            logo_asset_id: draft.theme.logo_asset_ref,
            custom_css: draft.theme.custom_css,
          },
    locales,
    default_locale: locales[0] ?? 'en',
    registration_fields: readRegistrationFields(draft.registration_fields),
  };
}

/** Reads a stored snapshot defensively: an older row may lack a field this build expects. */
export function readSnapshot(raw: unknown): PortalSnapshot | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const locales = strings(o.locales);
  const record = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const theme = o.theme;
  return {
    template_key: typeof o.template_key === 'string' ? o.template_key : DEFAULT_PORTAL_TEMPLATE,
    name: typeof o.name === 'string' ? o.name : '',
    methods: strings(o.methods),
    method_order: strings(o.method_order),
    identity_provider_ids: strings(o.identity_provider_ids),
    redirect_url: typeof o.redirect_url === 'string' ? o.redirect_url : null,
    terms_version: typeof o.terms_version === 'string' ? o.terms_version : null,
    theme:
      theme === null || typeof theme !== 'object'
        ? null
        : {
            colors: record(record(theme).colors),
            strings: record(record(theme).strings),
            logo_asset_id: text(record(theme).logo_asset_id),
            custom_css: text(record(theme).custom_css),
          },
    locales: locales.length === 0 ? ['en'] : locales,
    default_locale: typeof o.default_locale === 'string' ? o.default_locale : (locales[0] ?? 'en'),
    registration_fields: readRegistrationFields(o.registration_fields),
  };
}

// ---------------------------------------------------------------------------------------------
// Publish validation (§8 "Publish an immutable validated snapshot", §16 "do not silently
// publish incomplete templates")
// ---------------------------------------------------------------------------------------------

export interface PublishProblem {
  readonly path: string;
  readonly message: string;
}

export interface PublishContext {
  /**
   * Whether the snapshot's `terms_version` has published text. Undefined = not looked up, which
   * skips the check rather than guessing. Only meaningful when `terms_version` is non-null.
   */
  readonly termsTextAvailable?: boolean;
}

/**
 * Why this snapshot may not be published. An empty array means publishable.
 *
 * The central check is that the portal would actually offer a guest something. A portal whose
 * only enabled method depends on an unconfigured provider renders a page with no way to connect,
 * and publishing that is worse than refusing: the guest sees a dead end and the operator believes
 * the portal is live.
 */
export function publishProblems(
  snapshot: PortalSnapshot,
  capabilities: PortalCapabilities,
  context: PublishContext = {},
): PublishProblem[] {
  const problems: PublishProblem[] = [];

  if (portalTemplate(snapshot.template_key) === null) {
    problems.push({ path: 'template_key', message: `unknown template ${snapshot.template_key}` });
  }

  for (const key of snapshot.methods) {
    if (portalMethod(key) === null) {
      problems.push({ path: 'auth_methods', message: `unknown login method ${key}` });
    }
  }

  const offered = offeredMethods(snapshot.methods, snapshot.method_order, capabilities);
  if (offered.length === 0) {
    const blocked = snapshot.methods
      .map((key) => ({ key, availability: methodAvailability(key, capabilities) }))
      .filter((m) => !m.availability.available);
    const detail =
      snapshot.methods.length === 0
        ? 'no login method is enabled'
        : blocked.length > 0
          ? `every enabled method is unavailable: ${blocked
              .map((m) =>
                m.availability.available
                  ? m.key
                  : `${m.key} needs ${m.availability.missing.join(', ')}`,
              )
              .join('; ')}`
          : 'no enabled method has a guest page';
    problems.push({
      path: 'auth_methods',
      message: `${detail}; guests would have no way to connect`,
    });
  }

  // click_through with NO terms document is legitimate: §4.1 makes acceptance explicit only
  // "when configured", and the renderer shows a "no terms provided" line rather than an empty
  // box. The platform-default connect portal relies on exactly that. What is not legitimate is
  // claiming a version that has no text, because then the page promises a document it cannot
  // show, so the check fires on a dangling reference and not on absence.
  if (snapshot.terms_version !== null && context.termsTextAvailable === false) {
    problems.push({
      path: 'terms_version',
      message: `terms version ${snapshot.terms_version} has no published text`,
    });
  }

  if (snapshot.methods.includes('registration') && snapshot.registration_fields.length === 0) {
    problems.push({
      path: 'registration_fields',
      message: 'the registration method is enabled but the form has no fields',
    });
  }

  const required = snapshot.registration_fields.filter((f) => f.required && f.marketing === true);
  if (required.length > 0) {
    problems.push({
      path: 'registration_fields',
      message: 'marketing consent must not be required for access',
    });
  }

  if (!snapshot.locales.includes(snapshot.default_locale)) {
    problems.push({
      path: 'default_locale',
      message: `default locale ${snapshot.default_locale} is not among the offered locales`,
    });
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------
// Runtime read path
// ---------------------------------------------------------------------------------------------

/**
 * The published configuration a guest is served, or null when the portal has never been
 * published. Null is a refusal, not a fallback to the draft: §8 requires that guests see a
 * validated immutable snapshot, and an unpublished portal has nothing validated to show. The
 * migration published version 1 of every portal that already existed, so this only affects
 * portals created and left unfinished.
 */
export async function loadPublishedSnapshot(
  trx: DbTransaction,
  portal: { readonly id: string; readonly published_version_id: string | null },
): Promise<{ readonly versionId: string; readonly snapshot: PortalSnapshot } | null> {
  if (portal.published_version_id === null) return null;
  const row = await trx
    .selectFrom('portal_versions')
    .select(['id', 'snapshot'])
    .where('id', '=', portal.published_version_id)
    .where('captive_portal_id', '=', portal.id)
    .executeTakeFirst();
  if (row === undefined) return null;
  const snapshot = readSnapshot(row.snapshot);
  return snapshot === null ? null : { versionId: row.id, snapshot };
}

/**
 * The methods a guest may be offered by this published snapshot. Two filters, both deliberate:
 *
 *  - `methodAvailability` (inside `offeredMethods`) drops a method whose provider is not
 *    configured, so a portal that lists `email_otp` without SMTP shows no email button (§5);
 *  - `isLegacyPortalMethod` drops a method whose guest page HAS NOT BEEN BUILT IN THIS BUILD, so
 *    a stored method cannot render a button to a route that does not exist. Each stage that ships
 *    a page widens this, and `legacy` is the accident of which three came first rather than a
 *    statement about age.
 *
 * NOT a security control, despite the shape. `identify`'s body is a discriminated union of three
 * `z.literal` method values, so an unimplemented method is refused by the schema with a 400
 * before `methods` is consulted; the `methods.includes(method)` check in `identify` is defence in
 * depth for the three that exist. What this function actually prevents is a guest-facing dead
 * link, which is why it stays narrow while the renderer below it becomes template-aware.
 */
export function offeredGuestMethods(
  snapshot: PortalSnapshot,
  capabilities: PortalCapabilities,
): PortalLoginMethod[] {
  return offeredMethods(snapshot.methods, snapshot.method_order, capabilities)
    .map((m) => m.key)
    .filter((key): key is PortalLoginMethod => isLegacyPortalMethod(key));
}
