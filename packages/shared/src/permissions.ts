/**
 * Permission keys are `resource:action` strings (DECISIONS.md D-021); the catalogue below is
 * the canonical seed from MULTITENANCY.md §4.2 and the role templates from §4.3.
 * This module holds DATA and type guards only; the evaluation algorithm (§4.4) lives in the
 * API's authorization layer and must never compare role names.
 */
export type PermissionKey = `${string}:${string}`;

export type PermissionScope = 'platform' | 'organization' | 'site';

const SEGMENT = '[a-z][a-z0-9_]*';
const PERMISSION_KEY_RE = new RegExp(`^${SEGMENT}(?::${SEGMENT})+$`);

/** True for canonical keys such as `organization:read` or `platform:settings:update`. */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === 'string' && PERMISSION_KEY_RE.test(value);
}

/**
 * Accepts the ezecontroller precedent's dotted form (`device.read`) for one release
 * (MULTITENANCY.md §4.1) and returns the canonical colon form, or `undefined` when invalid.
 */
export function normalizePermissionKey(value: string): PermissionKey | undefined {
  const normalized = value.trim().replaceAll('.', ':');
  return isPermissionKey(normalized) ? normalized : undefined;
}

export interface PermissionDefinition {
  readonly key: PermissionKey;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
  /** Narrowest binding scope that may carry this key (MULTITENANCY.md §4.2 "Min scope"). */
  readonly minScope: PermissionScope;
  /** Only grantable through a platform binding (MULTITENANCY.md §4.4 step 6). */
  readonly platformOnly: boolean;
}

interface ResourceSpec {
  resource: string;
  label: string;
  minScope: PermissionScope;
  actions: readonly string[];
  /** Per-action overrides of the minimum scope. */
  scopeOverrides?: Readonly<Record<string, PermissionScope>>;
  platformOnly?: boolean | readonly string[];
}

const ACTION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  read: 'View {label}',
  create: 'Create {label}',
  update: 'Update {label}',
  delete: 'Delete {label}',
  suspend: 'Suspend {label}',
  'settings:update': 'Update {label} settings',
  'config:push': 'Push configuration to {label}',
  'secret:rotate': 'Rotate the shared secret of {label}',
  'key:rotate': 'Rotate the key pair of {label}',
  invite: 'Invite {label}',
  disable: 'Disable {label}',
  'binding:create': 'Grant role bindings to {label}',
  'binding:delete': 'Revoke role bindings from {label}',
  'password:reset': 'Reset the password of {label}',
  export: 'Export {label}',
  block: 'Block {label}',
  preview: 'Preview enforceability of {label}',
  revoke: 'Revoke {label}',
  reveal: 'Reveal the secret code of {label}',
  disconnect: 'Disconnect {label}',
  coa: 'Send RADIUS CoA to {label}',
  impersonate: 'Impersonate {label} (audited, time-limited)',
  list: 'List {label}',
  'adapter:manage': 'Manage NAS adapters on the {label}',
  'role_template:manage': 'Manage role templates on the {label}',
  'health:read': 'Read health status of the {label}',
};

/** MULTITENANCY.md §4.2, row by row. */
const RESOURCES: readonly ResourceSpec[] = [
  {
    resource: 'organization',
    label: 'organizations',
    minScope: 'organization',
    actions: ['read', 'update', 'create', 'suspend', 'delete', 'settings:update'],
    scopeOverrides: { create: 'platform', delete: 'platform', suspend: 'platform' },
    platformOnly: ['create', 'delete', 'suspend'],
  },
  {
    resource: 'site',
    label: 'sites',
    minScope: 'site',
    actions: ['read', 'create', 'update', 'delete'],
    scopeOverrides: { create: 'organization', delete: 'organization' },
  },
  {
    resource: 'network_device',
    label: 'network devices',
    minScope: 'site',
    actions: ['read', 'create', 'update', 'delete', 'config:push'],
  },
  {
    resource: 'nas',
    label: 'NAS entries',
    minScope: 'site',
    actions: ['read', 'create', 'update', 'delete', 'secret:rotate'],
  },
  {
    resource: 'wireguard_peer',
    label: 'WireGuard peers',
    minScope: 'site',
    actions: ['read', 'create', 'update', 'delete', 'key:rotate'],
  },
  {
    resource: 'administrator',
    label: 'administrators',
    minScope: 'organization',
    actions: ['read', 'invite', 'update', 'disable', 'binding:create', 'binding:delete'],
  },
  {
    resource: 'role',
    label: 'roles',
    minScope: 'organization',
    actions: ['read', 'create', 'update', 'delete'],
  },
  {
    resource: 'user',
    label: 'subscriber users',
    minScope: 'site',
    actions: ['read', 'create', 'update', 'delete', 'suspend', 'password:reset', 'export'],
  },
  {
    resource: 'user_group',
    label: 'user groups',
    minScope: 'organization',
    actions: ['read', 'create', 'update', 'delete'],
  },
  {
    resource: 'client_device',
    label: 'client devices',
    minScope: 'site',
    actions: ['read', 'create', 'update', 'delete', 'block'],
  },
  {
    resource: 'policy',
    label: 'policies',
    minScope: 'organization',
    actions: ['read', 'create', 'update', 'delete', 'preview'],
  },
  {
    resource: 'policy_assignment',
    label: 'policy assignments',
    minScope: 'site',
    actions: ['read', 'create', 'delete'],
  },
  {
    resource: 'voucher',
    label: 'vouchers',
    minScope: 'site',
    actions: ['read', 'create', 'revoke', 'export', 'reveal'],
  },
  {
    resource: 'session',
    label: 'sessions',
    minScope: 'site',
    actions: ['read', 'disconnect', 'coa'],
  },
  {
    resource: 'accounting',
    label: 'accounting data',
    minScope: 'site',
    actions: ['read', 'export'],
  },
  { resource: 'report', label: 'reports', minScope: 'site', actions: ['read', 'export'] },
  {
    resource: 'captive_portal',
    label: 'captive portals',
    minScope: 'site',
    actions: ['read', 'create', 'update', 'delete'],
  },
  {
    resource: 'portal_theme',
    label: 'portal themes',
    minScope: 'organization',
    actions: ['read', 'create', 'update', 'delete'],
  },
  {
    resource: 'identity_provider',
    label: 'identity providers',
    minScope: 'organization',
    actions: ['read', 'create', 'update', 'delete'],
  },
  {
    resource: 'api_key',
    label: 'API keys',
    minScope: 'organization',
    actions: ['read', 'create', 'revoke'],
  },
  {
    resource: 'webhook',
    label: 'webhooks',
    minScope: 'organization',
    actions: ['read', 'create', 'update', 'delete'],
  },
  {
    resource: 'audit_log',
    label: 'audit log entries',
    minScope: 'site',
    actions: ['read', 'export'],
  },
  {
    resource: 'tenant',
    label: 'tenants',
    minScope: 'platform',
    actions: ['impersonate', 'list'],
    platformOnly: true,
  },
  {
    resource: 'platform',
    label: 'platform',
    minScope: 'platform',
    actions: ['settings:update', 'adapter:manage', 'role_template:manage', 'health:read'],
    platformOnly: true,
  },
];

function describe(action: string, label: string): string {
  const template = ACTION_DESCRIPTIONS[action] ?? `${action} {label}`;
  return template.replace('{label}', label);
}

function buildCatalogue(): readonly PermissionDefinition[] {
  const out: PermissionDefinition[] = [];
  for (const spec of RESOURCES) {
    for (const action of spec.actions) {
      const key: PermissionKey = `${spec.resource}:${action}`;
      const platformOnly =
        spec.platformOnly === true ||
        (Array.isArray(spec.platformOnly) && spec.platformOnly.includes(action));
      out.push(
        Object.freeze({
          key,
          resource: spec.resource,
          action,
          description: describe(action, spec.label),
          minScope: spec.scopeOverrides?.[action] ?? spec.minScope,
          platformOnly,
        }),
      );
    }
  }
  return Object.freeze(out);
}

/** Canonical permission catalogue (seed rows of the `permissions` table). */
export const PERMISSION_CATALOGUE: readonly PermissionDefinition[] = buildCatalogue();

export const PERMISSION_KEYS: readonly PermissionKey[] = Object.freeze(
  PERMISSION_CATALOGUE.map((p) => p.key),
);

const CATALOGUE_BY_KEY: ReadonlyMap<PermissionKey, PermissionDefinition> = new Map(
  PERMISSION_CATALOGUE.map((p) => [p.key, p]),
);

export function getPermission(key: string): PermissionDefinition | undefined {
  return isPermissionKey(key) ? CATALOGUE_BY_KEY.get(key) : undefined;
}

export function isKnownPermission(key: unknown): key is PermissionKey {
  return isPermissionKey(key) && CATALOGUE_BY_KEY.has(key);
}

// ---------------------------------------------------------------------------------------------
// Role templates (MULTITENANCY.md §4.3) — seed rows in `roles` with organization_id IS NULL.
// ---------------------------------------------------------------------------------------------

export const ROLE_TEMPLATE_KEYS = [
  'platform_super_admin',
  'platform_support',
  'org_admin',
  'site_admin',
  'operator',
  'read_only',
] as const;

export type RoleTemplateKey = (typeof ROLE_TEMPLATE_KEYS)[number];

export interface RoleTemplate {
  readonly key: RoleTemplateKey;
  /** Owner's role name. */
  readonly name: string;
  /** Default `role_bindings.scope_type` values for bindings of this template. */
  readonly defaultScopeTypes: readonly PermissionScope[];
  readonly permissions: readonly PermissionKey[];
}

const ALL_KEYS = PERMISSION_KEYS;
const NON_PLATFORM_KEYS = PERMISSION_CATALOGUE.filter((p) => !p.platformOnly).map((p) => p.key);
const READ_KEYS = PERMISSION_CATALOGUE.filter((p) => p.action === 'read').map((p) => p.key);
const TENANT_READ_KEYS = PERMISSION_CATALOGUE.filter(
  (p) => p.action === 'read' && !p.platformOnly,
).map((p) => p.key);

function keysOf(resource: string, actions?: readonly string[]): PermissionKey[] {
  return PERMISSION_CATALOGUE.filter(
    (p) => p.resource === resource && (actions === undefined || actions.includes(p.action)),
  ).map((p) => p.key);
}

function unique(keys: readonly PermissionKey[]): readonly PermissionKey[] {
  return Object.freeze([...new Set(keys)]);
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = Object.freeze([
  {
    key: 'platform_super_admin',
    name: 'Platform Super Admin',
    defaultScopeTypes: ['platform'],
    permissions: unique(ALL_KEYS),
  },
  {
    // "all *:read, tenant:list, tenant:impersonate, session:disconnect, session:coa,
    //  audit_log:*, platform:health:read" — no create/update/delete on tenant configuration.
    key: 'platform_support',
    name: 'Platform Support',
    defaultScopeTypes: ['platform'],
    permissions: unique([
      ...READ_KEYS,
      'tenant:list',
      'tenant:impersonate',
      'session:disconnect',
      'session:coa',
      ...keysOf('audit_log'),
      'platform:health:read',
    ]),
  },
  {
    key: 'org_admin',
    name: 'Organization Admin',
    defaultScopeTypes: ['organization'],
    permissions: unique(NON_PLATFORM_KEYS),
  },
  {
    key: 'site_admin',
    name: 'Site Admin',
    defaultScopeTypes: ['site'],
    permissions: unique([
      ...keysOf('site', ['read', 'update']),
      ...keysOf('network_device'),
      ...keysOf('nas', ['read']),
      ...keysOf('user'),
      ...keysOf('client_device'),
      ...keysOf('policy', ['read', 'preview']),
      ...keysOf('policy_assignment'),
      ...keysOf('voucher', ['read', 'create', 'revoke', 'export']),
      ...keysOf('session'),
      ...keysOf('accounting'),
      ...keysOf('report'),
      ...keysOf('captive_portal', ['read', 'update']),
      ...keysOf('audit_log', ['read']),
    ]),
  },
  {
    // "*:read on site/device objects" interpreted as site, network_device, nas and
    // wireguard_peer reads (the site-scoped infrastructure resources of §4.2).
    key: 'operator',
    name: 'Operator / Support',
    defaultScopeTypes: ['site', 'organization'],
    permissions: unique([
      ...keysOf('user', ['read', 'update', 'password:reset']),
      ...keysOf('client_device', ['read', 'update', 'block']),
      ...keysOf('voucher', ['read', 'create']),
      ...keysOf('session', ['read', 'disconnect']),
      ...keysOf('accounting', ['read']),
      ...keysOf('report', ['read']),
      ...keysOf('site', ['read']),
      ...keysOf('network_device', ['read']),
      ...keysOf('nas', ['read']),
      ...keysOf('wireguard_peer', ['read']),
    ]),
  },
  {
    // "every *:read except voucher:reveal, audit_log:export"; platform-only keys are excluded
    // because this template binds at organization/site scope only (§4.4 step 6).
    key: 'read_only',
    name: 'Read Only',
    defaultScopeTypes: ['site', 'organization'],
    permissions: unique(
      TENANT_READ_KEYS.filter((k) => k !== 'voucher:reveal' && k !== 'audit_log:export'),
    ),
  },
]);

const TEMPLATE_BY_KEY: ReadonlyMap<RoleTemplateKey, RoleTemplate> = new Map(
  ROLE_TEMPLATES.map((t) => [t.key, t]),
);

export function getRoleTemplate(key: RoleTemplateKey): RoleTemplate {
  const template = TEMPLATE_BY_KEY.get(key);
  if (template === undefined) throw new Error(`Unknown role template: ${key}`);
  return template;
}
