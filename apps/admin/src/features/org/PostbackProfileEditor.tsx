/**
 * NAS `adapter_config` editor for the `external-portal-postback` adapter (Cycle C, migration 030).
 * Picks a built-in vendor profile or the configurable "any vendor" profile and edits its
 * parameter names. The API is the authority (`parsePostbackNasConfig`: strict allow-list); the
 * checks here only give early hints with the same rules.
 */
import { useState } from 'react';
import { CheckboxField, SelectField, TextAreaField, TextField } from '../../components/ui';

/** Built-in profiles (mirror of @ecloud/adapters BUILTIN_POSTBACK_PROFILES; drift-tested). */
export const POSTBACK_PROFILES = [
  { key: 'cambium-hotspot', label: 'Cambium cnPilot / cnMaestro External Hotspot', targets: [] },
  {
    key: 'aruba-ecp',
    label: 'HPE Aruba Instant / Central / AOS 8',
    targets: [
      { value: 'securelogin', label: 'securelogin.arubanetworks.com (Instant / Central)' },
      { value: 'switchip', label: 'Controller switch IP (AOS 8, switchip in redirect)' },
    ],
  },
  { key: 'cisco-webauth', label: 'Cisco Catalyst 9800 / AireOS web-auth', targets: [] },
  { key: 'fortinet-ecp', label: 'Fortinet FortiGate / FortiWiFi', targets: [] },
  { key: 'ruckus-wispr', label: 'Ruckus WISPr hotspot (browser login)', targets: [] },
  { key: 'omada-external-portal', label: 'TP-Link Omada external portal + RADIUS', targets: [] },
  { key: 'huawei-portal', label: 'Huawei external portal (HTTP relay)', targets: [] },
  { key: 'postback-generic', label: 'Any vendor (enter parameter names)', targets: [] },
] as const;

export const POSTBACK_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;

const PARAMS = [
  ['client_mac', 'Client MAC parameter', true],
  ['login_url', 'Login (post-back) URL parameter', true],
  ['ap_mac', 'AP MAC parameter', false],
  ['nas_id', 'NAS-ID parameter', false],
  ['ssid', 'SSID parameter', false],
  ['client_ip', 'Client IP parameter', false],
  ['continue_url', 'Continue URL parameter', false],
  ['vendor_token', 'Vendor token parameter (echoed back)', false],
] as const;

const FIELDS = [
  ['username', 'Username form field (default username)'],
  ['password', 'Password form field (default password)'],
  ['continue_url', 'Continue URL form field'],
  ['vendor_token', 'Vendor token form field'],
] as const;

interface Generic {
  params: Record<string, string>;
  fields: Record<string, string>;
  method: 'POST' | 'GET';
  constants?: Record<string, string>;
  append_query?: boolean;
  login_path?: string;
  login_port?: number;
}

interface Config {
  profile?: string;
  https?: boolean;
  login_target?: string;
  login_hosts?: string[];
  strict_login_hosts?: boolean;
  generic?: Generic;
}

function parse(value: string): Config {
  if (value === '') return {};
  try {
    const v: unknown = JSON.parse(value);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function clean(config: Config): string {
  const out: Config = { ...config };
  if (out.login_hosts !== undefined && out.login_hosts.length === 0) delete out.login_hosts;
  if (out.login_target === '') delete out.login_target;
  if (out.profile !== 'postback-generic') delete out.generic;
  return JSON.stringify(out);
}

function nameError(v: string | undefined): string | undefined {
  return v === undefined || v === '' || POSTBACK_NAME_RE.test(v)
    ? undefined
    : 'Letters, digits, _ . - only; starts with a letter; at most 32 characters.';
}

export function PostbackProfileEditor({
  value,
  error,
  onChange,
}: {
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const config = parse(value);
  const set = (next: Config) => onChange(clean(next));
  const profile = POSTBACK_PROFILES.find((p) => p.key === config.profile);
  const generic: Generic = config.generic ?? { params: {}, fields: {}, method: 'POST' };
  const setGeneric = (g: Generic) => set({ ...config, generic: g });
  // Kept as typed (a half-typed line is not lost); parsed into `constants` on every change.
  const [constantsText, setConstantsText] = useState(() =>
    Object.entries(generic.constants ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );

  return (
    <fieldset className="space-y-3 rounded border border-border p-3" aria-label="Post-back profile">
      <legend className="px-1 text-sm font-medium">External captive portal profile</legend>
      <SelectField
        label="Vendor profile"
        required
        error={error}
        placeholder="Select…"
        options={POSTBACK_PROFILES.map((p) => ({ value: p.key, label: p.label }))}
        value={config.profile ?? ''}
        onChange={(e) => set({ ...config, profile: e.target.value })}
        hint="Parameter names come from vendor documentation; every profile is REQUIRES_DEVICE_TEST until a lab test."
      />
      {profile !== undefined && profile.targets.length > 0 ? (
        <SelectField
          label="Login target"
          options={profile.targets}
          placeholder="Profile default"
          value={config.login_target ?? ''}
          onChange={(e) => set({ ...config, login_target: e.target.value })}
        />
      ) : null}
      <CheckboxField
        label="Post back over HTTPS"
        hint="Only when the AP / controller has a trusted certificate (Cambium port 444, Ruckus 9998)."
        checked={config.https === true}
        onChange={(checked) => set({ ...config, https: checked })}
      />
      <TextField
        label="Extra login hosts"
        hint="AP / controller addresses the browser may post to besides private addresses and the NAS IP (comma separated; e.g. a Cisco virtual IP or an Omada cloud controller). At most 8."
        value={(config.login_hosts ?? []).join(', ')}
        onChange={(e) =>
          set({
            ...config,
            login_hosts: e.target.value
              .split(/[,\s]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      />
      <CheckboxField
        label="Strict login hosts"
        hint="Accept only the NAS IP, the extra login hosts and documented vendor names (e.g. securelogin.arubanetworks.com). Enable when all guests log in at one controller / gateway; leave off when every AP serves its own login page (e.g. Cambium), which needs the private-address rule."
        checked={config.strict_login_hosts === true}
        onChange={(checked) => set({ ...config, strict_login_hosts: checked })}
      />
      {config.profile === 'postback-generic' ? (
        <div className="space-y-3">
          <p className="text-xs text-subtle">
            Enter the names your device uses (from a captured redirect). The portal URL must name
            this NAS: https://portal.ezecloud.ezelink.ai/pb/postback-generic/&lt;NAS identifier&gt;/
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {PARAMS.map(([key, label, required]) => (
              <TextField
                key={`p-${key}`}
                label={label}
                required={required}
                value={generic.params[key] ?? ''}
                error={nameError(generic.params[key])}
                onChange={(e) => {
                  const params = { ...generic.params, [key]: e.target.value.trim() };
                  if (params[key] === '') delete params[key];
                  setGeneric({ ...generic, params });
                }}
              />
            ))}
            {FIELDS.map(([key, label]) => (
              <TextField
                key={`f-${key}`}
                label={label}
                value={generic.fields[key] ?? ''}
                error={nameError(generic.fields[key])}
                onChange={(e) => {
                  const fields = { ...generic.fields, [key]: e.target.value.trim() };
                  if (fields[key] === '') delete fields[key];
                  setGeneric({ ...generic, fields });
                }}
              />
            ))}
            <SelectField
              label="Post-back method"
              options={[
                { value: 'POST', label: 'POST form' },
                { value: 'GET', label: 'GET (query string)' },
              ]}
              value={generic.method}
              onChange={(e) =>
                setGeneric({ ...generic, method: e.target.value === 'GET' ? 'GET' : 'POST' })
              }
            />
            <TextField
              label="Login path on the device"
              required
              hint="Exact path of the login URL, e.g. /login. Other paths are refused."
              value={generic.login_path ?? ''}
              onChange={(e) => setGeneric({ ...generic, login_path: e.target.value.trim() })}
            />
            <TextField
              label="Login port on the device"
              type="number"
              min={1}
              max={65535}
              hint="Leave empty for 80 (http) / 443 (https). Other ports are refused."
              value={generic.login_port === undefined ? '' : String(generic.login_port)}
              onChange={(e) => {
                const next = { ...generic };
                if (e.target.value === '') delete next.login_port;
                else next.login_port = Number(e.target.value);
                setGeneric(next);
              }}
            />
            {generic.method === 'GET' ? (
              <p role="alert" className="text-xs text-danger sm:col-span-2">
                GET puts the single-use credential in the URL (browser history, proxy and device
                logs). Use POST if the device supports it.
              </p>
            ) : null}
            <CheckboxField
              label="Append the received query to the login URL"
              checked={generic.append_query === true}
              onChange={(checked) => setGeneric({ ...generic, append_query: checked })}
            />
          </div>
          <TextAreaField
            label="Constant form fields (name=value per line, at most 8)"
            rows={3}
            value={constantsText}
            onChange={(e) => {
              setConstantsText(e.target.value);
              const constants: Record<string, string> = {};
              for (const line of e.target.value.split('\n')) {
                const i = line.indexOf('=');
                if (i > 0) constants[line.slice(0, i).trim()] = line.slice(i + 1).trim();
              }
              setGeneric({ ...generic, constants });
            }}
          />
        </div>
      ) : null}
    </fieldset>
  );
}
