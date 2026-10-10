/**
 * `nas_clients.adapter_config` of an `external-portal-postback` NAS (migration 030): which
 * profile the NAS uses, the login-target choice, extra allowed login hosts, and — for the
 * configurable "any vendor" profile — the redirect parameter names and post-back field names.
 *
 * Strict allow-list validation (names `^[A-Za-z][A-Za-z0-9_.-]{0,31}$`, bounded counts and
 * lengths, no unknown keys). The result is pure data; nothing here is ever fetched.
 */
import {
  BUILTIN_POSTBACK_PROFILES,
  GENERIC_POSTBACK_PROFILE_KEY,
  builtinPostbackProfile,
  type PostbackProfile,
} from './profiles.js';

export const POSTBACK_PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const CONSTANT_VALUE_RE = /^[A-Za-z0-9_.:@/+-]{0,64}$/;
const DNS_NAME_RE =
  /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const POSTBACK_LIMITS = Object.freeze({
  loginHosts: 8,
  constants: 8,
  configChars: 4096,
});

export interface GenericPostbackConfig {
  readonly params: {
    readonly client_mac: string;
    readonly login_url: string;
    readonly ap_mac?: string;
    readonly nas_id?: string;
    readonly ssid?: string;
    readonly client_ip?: string;
    readonly continue_url?: string;
    readonly vendor_token?: string;
  };
  readonly fields: {
    readonly username: string;
    readonly password: string;
    readonly continue_url?: string;
    readonly vendor_token?: string;
  };
  readonly method: 'POST' | 'GET';
  readonly constants: Readonly<Record<string, string>>;
  readonly append_query: boolean;
  /** Review M1: exact login path on the device (required). */
  readonly login_path: string;
  /** Review M1: login port (null = scheme default 80 / 443). */
  readonly login_port: number | null;
}

export interface PostbackNasConfig {
  readonly profile: string;
  /** Scheme for `param-host` targets offering both (null = profile default). */
  readonly https: boolean | null;
  /** Named login target of the profile (null = profile default). */
  readonly login_target: string | null;
  /** Extra hosts the login URL may use (the AP / controller address; lower-case). */
  readonly login_hosts: readonly string[];
  /**
   * Review M2: when true (and login hosts or the NAS IP are known), ONLY the registered NAS IP,
   * `login_hosts` and documented intercept names are accepted — no "any private IPv4". Leave
   * false when every AP serves its own login page (Cambium `ga_srvr` = each AP's own IP).
   */
  readonly strict_login_hosts: boolean;
  readonly generic: GenericPostbackConfig | null;
}

export type PostbackConfigResult =
  | { readonly ok: true; readonly config: PostbackNasConfig }
  | { readonly ok: false; readonly errors: readonly { path: string; message: string }[] };

const PARAM_KEYS = [
  'client_mac',
  'login_url',
  'ap_mac',
  'nas_id',
  'ssid',
  'client_ip',
  'continue_url',
  'vendor_token',
] as const;
const FIELD_KEYS = ['username', 'password', 'continue_url', 'vendor_token'] as const;
const TOP_KEYS = [
  'profile',
  'https',
  'login_target',
  'login_hosts',
  'strict_login_hosts',
  'generic',
] as const;
const GENERIC_KEYS = [
  'params',
  'fields',
  'method',
  'constants',
  'append_query',
  'login_path',
  'login_port',
] as const;
export const POSTBACK_LOGIN_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,128}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ipv4Octets(value: string): number[] | null {
  const m = IPV4_RE.exec(value);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  return o.some((n) => n > 255) ? null : o;
}

/**
 * A host the login URL may name: an IPv4 literal that is not unspecified, loopback,
 * link-local / metadata, multicast or broadcast, or a DNS name with at least one dot that is
 * not `localhost`. IPv6 literals are refused (no vendor login URL documented on IPv6).
 */
export function normalizeLoginHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  const o = ipv4Octets(host);
  if (o) {
    const [a = 0, b = 0] = o;
    if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224) return null;
    return o.join('.');
  }
  if (/^\d+(\.\d+)*$/.test(host)) return null; // shorthand / invalid numeric hosts
  if (!DNS_NAME_RE.test(host)) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  return host;
}

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: { path: string; message: string }[],
): void {
  for (const k of Object.keys(obj))
    if (!allowed.includes(k)) errors.push({ path: `${path}.${k}`, message: 'unknown key' });
}

function name(
  v: unknown,
  path: string,
  errors: { path: string; message: string }[],
  required: boolean,
): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) errors.push({ path, message: 'required' });
    return undefined;
  }
  if (typeof v !== 'string' || !POSTBACK_PARAM_NAME_RE.test(v)) {
    errors.push({ path, message: 'must match ^[A-Za-z][A-Za-z0-9_.-]{0,31}$' });
    return undefined;
  }
  return v;
}

function parseGeneric(
  raw: unknown,
  errors: { path: string; message: string }[],
): GenericPostbackConfig | null {
  if (!isRecord(raw)) {
    errors.push({ path: 'generic', message: 'required object for the generic profile' });
    return null;
  }
  unknownKeys(raw, GENERIC_KEYS, 'generic', errors);
  const p = isRecord(raw.params) ? raw.params : {};
  if (!isRecord(raw.params)) errors.push({ path: 'generic.params', message: 'required object' });
  unknownKeys(p, PARAM_KEYS, 'generic.params', errors);
  const params: Record<string, string> = {};
  for (const k of PARAM_KEYS) {
    const v = name(p[k], `generic.params.${k}`, errors, k === 'client_mac' || k === 'login_url');
    if (v !== undefined) params[k] = v;
  }
  const seen = new Set<string>();
  for (const v of Object.values(params)) {
    if (seen.has(v)) errors.push({ path: 'generic.params', message: `duplicate name ${v}` });
    seen.add(v);
  }
  const f = raw.fields === undefined ? {} : raw.fields;
  if (!isRecord(f)) errors.push({ path: 'generic.fields', message: 'must be an object' });
  const fr = isRecord(f) ? f : {};
  unknownKeys(fr, FIELD_KEYS, 'generic.fields', errors);
  const fields: Record<string, string> = {
    username: name(fr.username, 'generic.fields.username', errors, false) ?? 'username',
    password: name(fr.password, 'generic.fields.password', errors, false) ?? 'password',
  };
  for (const k of ['continue_url', 'vendor_token'] as const) {
    const v = name(fr[k], `generic.fields.${k}`, errors, false);
    if (v !== undefined) fields[k] = v;
  }
  if (fields.username === fields.password)
    errors.push({ path: 'generic.fields', message: 'username and password fields must differ' });
  const method = raw.method === undefined ? 'POST' : raw.method;
  if (method !== 'POST' && method !== 'GET')
    errors.push({ path: 'generic.method', message: 'POST or GET' });
  const constants: Record<string, string> = {};
  if (raw.constants !== undefined) {
    if (!isRecord(raw.constants)) {
      errors.push({ path: 'generic.constants', message: 'must be an object' });
    } else {
      const entries = Object.entries(raw.constants);
      if (entries.length > POSTBACK_LIMITS.constants)
        errors.push({ path: 'generic.constants', message: `at most ${POSTBACK_LIMITS.constants}` });
      for (const [k, v] of entries.slice(0, POSTBACK_LIMITS.constants)) {
        if (!POSTBACK_PARAM_NAME_RE.test(k)) {
          errors.push({ path: `generic.constants.${k}`, message: 'invalid field name' });
          continue;
        }
        if (typeof v !== 'string' || !CONSTANT_VALUE_RE.test(v)) {
          errors.push({
            path: `generic.constants.${k}`,
            message: 'value must match [A-Za-z0-9_.:@/+-]{0,64}',
          });
          continue;
        }
        if (Object.values(fields).includes(k))
          errors.push({ path: `generic.constants.${k}`, message: 'collides with a field name' });
        constants[k] = v;
      }
    }
  }
  const loginPath = raw.login_path;
  if (typeof loginPath !== 'string' || !POSTBACK_LOGIN_PATH_RE.test(loginPath))
    errors.push({
      path: 'generic.login_path',
      message: 'required, e.g. /login (^/[A-Za-z0-9._~/-]{0,128}$)',
    });
  const loginPort = raw.login_port;
  if (
    loginPort !== undefined &&
    loginPort !== null &&
    !(
      typeof loginPort === 'number' &&
      Number.isInteger(loginPort) &&
      loginPort >= 1 &&
      loginPort <= 65535
    )
  )
    errors.push({ path: 'generic.login_port', message: 'an integer 1..65535' });
  if (raw.append_query !== undefined && typeof raw.append_query !== 'boolean')
    errors.push({ path: 'generic.append_query', message: 'must be a boolean' });
  return {
    params: params as unknown as GenericPostbackConfig['params'],
    fields: fields as unknown as GenericPostbackConfig['fields'],
    method: method === 'GET' ? 'GET' : 'POST',
    constants,
    append_query: raw.append_query === true,
    login_path: typeof loginPath === 'string' ? loginPath : '/',
    login_port: typeof loginPort === 'number' ? loginPort : null,
  };
}

/** Validates an admin-supplied `adapter_config` for an `external-portal-postback` NAS. */
export function parsePostbackNasConfig(input: unknown): PostbackConfigResult {
  const errors: { path: string; message: string }[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] };
  if (JSON.stringify(input).length > POSTBACK_LIMITS.configChars)
    return { ok: false, errors: [{ path: '', message: 'adapter_config too large' }] };
  unknownKeys(input, TOP_KEYS, 'adapter_config', errors);
  const profileKey = input.profile;
  const builtin = typeof profileKey === 'string' ? builtinPostbackProfile(profileKey) : null;
  const isGeneric = profileKey === GENERIC_POSTBACK_PROFILE_KEY;
  if (builtin === null && !isGeneric) {
    errors.push({
      path: 'profile',
      message: `one of ${[...BUILTIN_POSTBACK_PROFILES.map((p) => p.key), GENERIC_POSTBACK_PROFILE_KEY].join(', ')}`,
    });
  }
  if (
    input.strict_login_hosts !== undefined &&
    input.strict_login_hosts !== null &&
    typeof input.strict_login_hosts !== 'boolean'
  )
    errors.push({ path: 'strict_login_hosts', message: 'must be a boolean' });
  if (input.https !== undefined && input.https !== null && typeof input.https !== 'boolean')
    errors.push({ path: 'https', message: 'must be a boolean' });
  let loginTarget: string | null = null;
  if (input.login_target !== undefined && input.login_target !== null) {
    if (
      typeof input.login_target !== 'string' ||
      builtin === null ||
      !Object.prototype.hasOwnProperty.call(builtin.loginTargets, input.login_target)
    ) {
      errors.push({
        path: 'login_target',
        message:
          builtin === null
            ? 'not supported for this profile'
            : `one of ${Object.keys(builtin.loginTargets).join(', ')}`,
      });
    } else loginTarget = input.login_target;
  }
  const hosts: string[] = [];
  if (input.login_hosts !== undefined && input.login_hosts !== null) {
    if (!Array.isArray(input.login_hosts)) {
      errors.push({ path: 'login_hosts', message: 'must be an array' });
    } else {
      if (input.login_hosts.length > POSTBACK_LIMITS.loginHosts)
        errors.push({ path: 'login_hosts', message: `at most ${POSTBACK_LIMITS.loginHosts}` });
      input.login_hosts.slice(0, POSTBACK_LIMITS.loginHosts).forEach((h, i) => {
        const n = normalizeLoginHost(h);
        if (n === null)
          errors.push({
            path: `login_hosts.${i}`,
            message: 'an IPv4 address (not loopback / link-local / multicast) or a DNS name',
          });
        else if (!hosts.includes(n)) hosts.push(n);
      });
    }
  }
  let generic: GenericPostbackConfig | null = null;
  if (isGeneric) generic = parseGeneric(input.generic, errors);
  else if (input.generic !== undefined && input.generic !== null)
    errors.push({ path: 'generic', message: 'only for the postback-generic profile' });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      profile: profileKey as string,
      https: typeof input.https === 'boolean' ? input.https : null,
      strict_login_hosts: input.strict_login_hosts === true,
      login_target: loginTarget,
      login_hosts: hosts,
      generic,
    },
  };
}

/** The profile a validated config selects (the generic one is built from its parameter map). */
export function profileForConfig(config: PostbackNasConfig): PostbackProfile | null {
  if (config.profile !== GENERIC_POSTBACK_PROFILE_KEY)
    return builtinPostbackProfile(config.profile);
  const g = config.generic;
  if (g === null) return null;
  const opt = (v: string | undefined): readonly string[] | undefined =>
    v === undefined ? undefined : [v];
  const echo: Record<string, readonly string[]> = {};
  if (g.fields.vendor_token !== undefined && g.params.vendor_token !== undefined)
    echo[g.fields.vendor_token] = [g.params.vendor_token];
  return {
    key: GENERIC_POSTBACK_PROFILE_KEY,
    vendorKey: 'generic-postback',
    label: 'Any vendor: external captive portal post-back (configured parameter names)',
    productLines:
      'Configured per NAS (Grandstream, EnGenius, Zyxel, DrayTek, Ruijie, Extreme, Alcatel-Lucent, Tanaza, ...)',
    confidence: 'L',
    params: {
      clientMac: [g.params.client_mac],
      ...(g.params.ap_mac === undefined ? {} : { apMac: [g.params.ap_mac] }),
      ...(g.params.nas_id === undefined ? {} : { nasId: [g.params.nas_id] }),
      ...(g.params.ssid === undefined ? {} : { ssid: opt(g.params.ssid) }),
      ...(g.params.client_ip === undefined ? {} : { clientIp: opt(g.params.client_ip) }),
      ...(g.params.continue_url === undefined ? {} : { continueUrl: opt(g.params.continue_url) }),
      ...(g.params.vendor_token === undefined ? {} : { vendorToken: opt(g.params.vendor_token) }),
    },
    loginTargets: {
      configured: {
        kind: 'param-url',
        param: g.params.login_url,
        schemes: ['http', 'https'],
        // Review M1: a fixed path and port per NAS, never "any port / any path".
        path: g.login_path,
        ports: g.login_port === null ? [80, 443] : [g.login_port],
      },
    },
    defaultLoginTarget: 'configured',
    httpsDefault: false,
    method: g.method,
    fields: {
      username: g.fields.username,
      password: g.fields.password,
      ...(g.fields.continue_url === undefined ? {} : { continueUrl: g.fields.continue_url }),
      constants: g.constants,
      echo,
    },
    appendRawQuery: g.append_query,
    interceptHosts: [],
    // The parameter names are per NAS, so the NAS must be known before the query is read.
    pathNasIdRequired: true,
    radius: [
      {
        name: 'Session-Timeout',
        status: 'REQUIRES_DEVICE_TEST',
        note: 'standard attribute; vendor untested',
      },
      {
        name: 'Idle-Timeout',
        status: 'REQUIRES_DEVICE_TEST',
        note: 'standard attribute; vendor untested',
      },
      {
        name: 'Acct-Interim-Interval',
        status: 'REQUIRES_DEVICE_TEST',
        note: 'standard attribute; vendor untested',
      },
      {
        name: 'Class',
        status: 'REQUIRES_DEVICE_TEST',
        note: 'standard attribute; vendor untested',
      },
    ],
    evidence: [
      {
        kind: 'doc-section',
        ref: 'docs/VENDOR_INTEGRATION_RESEARCH.md §3.4 (postback-generic), §6 item 11',
      },
    ],
    requiresClarification: [
      'Parameter names are entered by the administrator from a lab capture of a real redirect (D-034); nothing is vendor-documented.',
    ],
  };
}

/** Canonical JSON object stored in `nas_clients.adapter_config` (nulls / defaults omitted). */
export function serializePostbackNasConfig(config: PostbackNasConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { profile: config.profile };
  if (config.https !== null) out.https = config.https;
  if (config.login_target !== null) out.login_target = config.login_target;
  if (config.login_hosts.length > 0) out.login_hosts = [...config.login_hosts];
  if (config.strict_login_hosts) out.strict_login_hosts = true;
  if (config.generic !== null) {
    const g = config.generic;
    out.generic = {
      params: { ...g.params },
      fields: { ...g.fields },
      method: g.method,
      ...(Object.keys(g.constants).length > 0 ? { constants: { ...g.constants } } : {}),
      ...(g.append_query ? { append_query: true } : {}),
      login_path: g.login_path,
      ...(g.login_port === null ? {} : { login_port: g.login_port }),
    };
  }
  return out;
}
