/**
 * Captive portal designer (ADMIN_UI_ARCHITECTURE.md §3/§4, Phase 6 P6-B): per-portal theme
 * assignment and login-method toggles, theme tokens with live WCAG contrast checks, logo upload
 * (branding storage), welcome/page texts, versioned terms, and a preview rendered server-side by
 * the portal page renderer with sample data (sandboxed iframe, no script).
 *
 * Everything is permission-driven: read-only principals (e.g. operators) see the same screen
 * with inputs disabled and no save actions; the API stays the authority.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  DEFAULT_PORTAL_COLORS,
  DEFAULT_PORTAL_STRINGS,
  PORTAL_COLOR_TOKENS,
  PORTAL_LOGIN_METHODS,
  PORTAL_PREVIEW_PAGES,
  PORTAL_STRING_KEYS,
  contrastIssues,
  resolvePortalColors,
  type PortalColorToken,
  type PortalColors,
  type PortalPreviewPage,
  type PortalStringKey,
} from '@ecloud/shared/portal-theme';
import { api, buildUrl, newIdempotencyKey, request, uploadFile } from '../../api/client';
import type { Row } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { SecretOnce } from '../../components/SecretOnce';
import {
  Badge,
  Button,
  Card,
  CheckboxField,
  Notice,
  PageHeader,
  SelectField,
  Spinner,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { RequireOrgPermission } from '../../layout/guards';
import { useAuth } from '../../lib/auth';
import { str } from '../../lib/format';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';
import { LOGIN_METHOD_LABELS } from './PortalsPage';

const COLOR_LABELS: Record<PortalColorToken, string> = {
  brand: 'Brand (buttons)',
  brand_text: 'Button text',
  background: 'Page background',
  surface: 'Card background',
  text: 'Text',
  muted: 'Secondary text',
  error: 'Error text',
};

const STRING_LABELS: Record<PortalStringKey, string> = {
  welcome_title: 'Welcome title',
  welcome_text: 'Welcome text',
  login_button: 'Sign-in button',
  voucher_button: 'Voucher button',
  click_through_button: 'Click-through button',
  success_text: 'Success page text',
  error_text: 'Error page text',
  expired_text: 'Expired page text',
  footer_text: 'Footer text',
};

const PAGE_LABELS: Record<PortalPreviewPage, string> = {
  landing: 'Landing',
  login: 'Login',
  voucher: 'Voucher',
  terms: 'Terms / click-through',
  success: 'Success',
  error: 'Error',
  expired: 'Expired',
  status: 'Status / logout',
};

const LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'ar', label: 'Arabic (RTL)' },
];

interface Theme {
  id: string;
  name: string;
  colors: Record<string, string>;
  strings: Record<string, Record<string, string>>;
  logo_asset_id: string | null;
  version: number;
}

interface Asset {
  id: string;
  content_type: string;
  byte_size: number;
}

interface TermsList {
  current_version: string | null;
  data: { id: string; version: number; locale: string; body: string; created_at: string }[];
}

type Strings = Partial<Record<PortalStringKey, string>>;

export function PortalDesignerPage() {
  return (
    <RequireOrgPermission permission="captive_portal:read">
      <Designer />
    </RequireOrgPermission>
  );
}

function Designer() {
  const orgId = useOrgId();
  const { portalId = '' } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();

  const portal = useQuery({
    queryKey: ['org', orgId, 'captive-portal', portalId],
    queryFn: ({ signal }) =>
      api('get', '/api/v1/orgs/{orgId}/captive-portals/{id}', {
        params: { orgId, id: portalId },
        signal,
      }) as Promise<Row>,
  });
  const canThemes = can(me, 'portal_theme:read', { organizationId: orgId });
  const themes = useQuery({
    queryKey: ['org', orgId, 'portal-themes', 'all'],
    enabled: canThemes,
    queryFn: ({ signal }) =>
      api('get', '/api/v1/orgs/{orgId}/portal-themes', {
        params: { orgId },
        query: { limit: 200 },
        signal,
      }) as unknown as Promise<{ data: Theme[] }>,
  });

  if (portal.isPending) return <Spinner label="Loading portal…" />;
  if (portal.error) return <ProblemAlert error={portal.error} />;
  const row = portal.data;
  const siteId = (row.site_id as string | undefined) ?? null;
  const canEditPortal = can(me, 'captive_portal:update', { organizationId: orgId, siteId });
  const themeList = themes.data?.data ?? [];
  const theme = themeList.find((t) => t.id === row.theme_id) ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId] });

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Portal designer: ${str(row.name)}`}
        description={
          <>
            Slug <code>{str(row.public_slug)}</code> · {str(row.portal_type)} ·{' '}
            <Link className="underline" to="..">
              all portals
            </Link>
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <PortalSettings
            orgId={orgId}
            portal={row}
            themes={themeList}
            canEdit={canEditPortal}
            onSaved={refresh}
          />
          <UamSecretCard orgId={orgId} portal={row} onRotated={refresh} />
          {canThemes ? (
            <ThemeEditor
              key={theme?.id ?? 'none'}
              orgId={orgId}
              portalId={portalId}
              theme={theme}
              onSaved={refresh}
            />
          ) : (
            <Notice tone="info">You do not have permission to view portal themes.</Notice>
          )}
          <TermsEditor orgId={orgId} portalId={portalId} canEdit={canEditPortal} />
        </div>
        {canThemes ? <PreviewPane orgId={orgId} portalId={portalId} theme={theme} /> : null}
      </div>
    </div>
  );
}

function PortalSettings({
  orgId,
  portal,
  themes,
  canEdit,
  onSaved,
}: {
  orgId: string;
  portal: Row;
  themes: Theme[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [themeId, setThemeId] = useState(str(portal.theme_id ?? ''));
  const [methods, setMethods] = useState<string[]>(
    Array.isArray(portal.auth_methods) ? (portal.auth_methods as string[]) : [],
  );
  const { me } = useAuth();
  const config = (portal.adapter_config ?? {}) as Record<string, unknown>;
  const storedUrl = typeof config.uam_server_url === 'string' ? config.uam_server_url : '';
  const storedNas = typeof config.nas_client_id === 'string' ? config.nas_client_id : '';
  const [uamUrl, setUamUrl] = useState(storedUrl);
  const [nasId, setNasId] = useState(storedNas);
  const siteId = str(portal.site_id ?? '');
  const canNas = can(me, 'nas:read', { organizationId: orgId, siteId });
  const nasList = useQuery({
    queryKey: ['org', orgId, 'nas', 'site', siteId],
    enabled: canNas && siteId !== '',
    queryFn: ({ signal }) =>
      api('get', '/api/v1/orgs/{orgId}/nas', {
        params: { orgId },
        query: { site_id: siteId, limit: 200 },
        signal,
      }) as unknown as Promise<{ data: Row[] }>,
  });
  const nasOptions = (nasList.data?.data ?? []).map((n) => ({
    value: n.id,
    label: `${str(n.name ?? n.id)} (${str(n.nas_ip ?? '')})`,
  }));
  if (storedNas !== '' && !nasOptions.some((o) => o.value === storedNas)) {
    nasOptions.push({ value: storedNas, label: storedNas });
  }
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        theme_id: themeId === '' ? null : themeId,
        auth_methods: methods,
      };
      if (uamUrl.trim() !== storedUrl)
        body.uam_server_url = uamUrl.trim() === '' ? null : uamUrl.trim();
      if (nasId !== storedNas) body.nas_client_id = nasId === '' ? null : nasId;
      return api('patch', '/api/v1/orgs/{orgId}/captive-portals/{id}', {
        params: { orgId, id: portal.id },
        body: body,
      });
    },
    onSuccess: onSaved,
  });
  const toggle = (method: string, on: boolean) =>
    setMethods((prev) => (on ? [...new Set([...prev, method])] : prev.filter((m) => m !== method)));

  return (
    <Card title="Portal assignment and login methods">
      <div className="space-y-3">
        <SelectField
          label="Theme"
          value={themeId}
          disabled={!canEdit}
          placeholder="Default theme"
          options={themes.map((t) => ({ value: t.id, label: `${t.name} (v${t.version})` }))}
          onChange={(e) => setThemeId(e.target.value)}
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Login methods</legend>
          {PORTAL_LOGIN_METHODS.map((m) => (
            <CheckboxField
              key={m}
              label={LOGIN_METHOD_LABELS[m] ?? m}
              checked={methods.includes(m)}
              disabled={!canEdit}
              onChange={(on) => toggle(m, on)}
            />
          ))}
          <div className="flex items-center gap-2 text-sm text-subtle">
            <input type="checkbox" disabled aria-label="Social login" className="h-4 w-4" />
            <span>Social login</span>
            <Badge tone="neutral">not configured</Badge>
          </div>
        </fieldset>
        {methods.length === 0 ? (
          <p className="text-xs text-danger">Enable at least one login method.</p>
        ) : null}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Hotspot binding</legend>
          <SelectField
            label="NAS (pin)"
            value={nasId}
            disabled={!canEdit || !canNas}
            placeholder="Not pinned (only portal of the site)"
            options={nasOptions}
            hint="The NAS of this site whose redirects this portal serves."
            onChange={(e) => setNasId(e.target.value)}
          />
          <TextField
            label="UAM server URL"
            value={uamUrl}
            disabled={!canEdit}
            placeholder="Default: portal origin + /uam/uspot/ or /uam/chilli/"
            hint="Must be on the portal origin with the UAM path of the hotspot type (https)."
            onChange={(e) => setUamUrl(e.target.value)}
          />
          <p className="text-xs text-subtle">
            Onboarding: create the portal → set the NAS pin and UAM server URL → generate the UAM
            secret → configure the NAS with that URL and secret.
          </p>
        </fieldset>
        <ProblemAlert error={save.error} />
        {canEdit ? (
          <div className="flex justify-end">
            <Button
              variant="primary"
              busy={save.isPending}
              disabled={methods.length === 0}
              onClick={() => save.mutate()}
            >
              Save portal
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * UAM shared secret (md signature between the hotspot and the portal). Write-only: the API
 * generates it, returns it once, and afterwards only reports whether one is configured.
 */
function UamSecretCard({
  orgId,
  portal,
  onRotated,
}: {
  orgId: string;
  portal: Row;
  onRotated: () => void;
}) {
  const { me } = useAuth();
  const impersonating = me?.kind === 'admin' && me.impersonation !== null;
  const canRotate =
    !impersonating && can(me, 'captive_portal:secret:rotate', { organizationId: orgId });
  const configured = portal.uam_secret_configured === true;
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const rotate = useMutation({
    mutationFn: () =>
      api('post', '/api/v1/orgs/{orgId}/captive-portals/{id}/rotate-uam-secret', {
        params: { orgId, id: portal.id },
        idempotencyKey: key,
      }),
    onSuccess: (res) => {
      setSecret(res.uam_secret);
      onRotated();
    },
  });
  const close = () => {
    setOpen(false);
    setSecret(null);
    setKey(newIdempotencyKey());
    rotate.reset();
  };
  return (
    <Card title="UAM shared secret">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          Status:{' '}
          <Badge tone={configured ? 'success' : 'warning'}>
            {configured ? 'configured' : 'not set'}
          </Badge>
        </span>
        {canRotate ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            {configured ? 'Rotate UAM secret' : 'Generate UAM secret'}
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-subtle">
        Signs the hotspot redirect (md). The secret is shown only once; it must be configured as the
        UAM secret on the access point or gateway.
      </p>
      <Dialog open={open} title="UAM shared secret" onClose={close}>
        {secret ? (
          <SecretOnce
            title="New UAM secret"
            value={secret}
            description="Configure this on the hotspot now. It is not shown again; the previous secret stops working immediately."
            onDone={close}
          />
        ) : (
          <div className="space-y-3 text-sm">
            <p>
              A new secret is generated{configured ? ' and the current one is invalidated' : ''}.
              Portal logins fail until the hotspot uses the new secret.
            </p>
            <ProblemAlert error={rotate.error} />
            <div className="flex justify-end gap-2">
              <Button onClick={close}>Cancel</Button>
              <Button variant="danger" busy={rotate.isPending} onClick={() => rotate.mutate()}>
                {configured ? 'Rotate secret' : 'Generate secret'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

function ThemeEditor({
  orgId,
  portalId,
  theme,
  onSaved,
}: {
  orgId: string;
  portalId: string;
  theme: Theme | null;
  onSaved: () => void;
}) {
  const { me } = useAuth();
  const target = { organizationId: orgId };
  const canEdit =
    theme === null
      ? can(me, 'portal_theme:create', target)
      : can(me, 'portal_theme:update', target);
  const canUpload = can(me, 'portal_asset:create', target);
  const canAssign = can(me, 'captive_portal:update', { organizationId: orgId, anySite: true });
  const [name, setName] = useState(theme?.name ?? 'New theme');
  const [colors, setColors] = useState<PortalColors>(resolvePortalColors(theme?.colors));
  const [strings, setStrings] = useState<Strings>(theme?.strings.en ?? {});
  const [logo, setLogo] = useState<string | null>(theme?.logo_asset_id ?? null);
  const issues = useMemo(() => contrastIssues(colors), [colors]);

  // Publish the draft for the preview pane (same tab, no server round trip until refresh).
  useEffect(() => {
    draftStore.set({ colors, strings: { en: strings }, logo_asset_id: logo });
  }, [colors, strings, logo]);

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadFile<Asset>(
        buildUrl('/api/v1/orgs/{orgId}/portal-assets', { orgId }, { filename: file.name }),
        file,
      ),
    onSuccess: (asset) => setLogo(asset.id),
  });
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name,
        colors,
        strings: { ...(theme?.strings ?? {}), en: strings },
        logo_asset_id: logo,
      };
      if (theme !== null) {
        return api('patch', '/api/v1/orgs/{orgId}/portal-themes/{id}', {
          params: { orgId, id: theme.id },
          body: body,
        });
      }
      const created = (await api('post', '/api/v1/orgs/{orgId}/portal-themes', {
        params: { orgId },
        body: body,
        idempotencyKey: newIdempotencyKey(),
      })) as { id: string };
      if (canAssign) {
        await api('patch', '/api/v1/orgs/{orgId}/captive-portals/{id}', {
          params: { orgId, id: portalId },
          body: { theme_id: created.id },
        });
      }
      return created;
    },
    onSuccess: onSaved,
  });

  return (
    <Card
      title={
        theme === null
          ? 'Theme (default — not saved yet)'
          : `Theme: ${theme.name} (v${theme.version})`
      }
    >
      <div className="space-y-4">
        <TextField
          label="Theme name"
          value={name}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Colours</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {PORTAL_COLOR_TOKENS.map((token) => (
              <ColorInput
                key={token}
                label={COLOR_LABELS[token]}
                value={colors[token]}
                disabled={!canEdit}
                onChange={(value) => setColors((c) => ({ ...c, [token]: value }))}
              />
            ))}
          </div>
          {issues.length > 0 ? (
            <Notice tone="warning" title="Contrast below WCAG AA (4.5:1)">
              <ul className="list-inside list-disc">
                {issues.map((i) => (
                  <li key={`${i.foreground}-${i.background}`}>
                    {COLOR_LABELS[i.foreground]} on {COLOR_LABELS[i.background]}: {i.ratio}:1
                  </li>
                ))}
              </ul>
            </Notice>
          ) : (
            <p className="mt-2 text-xs text-success">All text colours meet WCAG AA contrast.</p>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            disabled={!canEdit}
            onClick={() => setColors({ ...DEFAULT_PORTAL_COLORS })}
          >
            Reset colours
          </Button>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Logo</legend>
          {logo ? (
            <img
              src={`/api/v1/orgs/${orgId}/portal-assets/${logo}/content`}
              alt="Current logo"
              className="max-h-16 rounded border border-border bg-white p-1"
            />
          ) : (
            <p className="text-sm text-subtle">No logo.</p>
          )}
          {canUpload && canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-sm">
                <span className="sr-only">Upload logo</span>
                <input
                  type="file"
                  aria-label="Upload logo"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) upload.mutate(file);
                  }}
                />
              </label>
              {logo ? (
                <Button size="sm" variant="ghost" onClick={() => setLogo(null)}>
                  Remove logo
                </Button>
              ) : null}
              {upload.isPending ? <Spinner small label="Uploading…" /> : null}
            </div>
          ) : null}
          <p className="text-xs text-subtle">
            PNG, JPEG or WebP, at most 5 MiB (≤ 20 KB recommended for captive browsers).
          </p>
          <ProblemAlert error={upload.error} />
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Texts (English)</legend>
          {PORTAL_STRING_KEYS.map((key) =>
            key === 'welcome_text' || key === 'footer_text' ? (
              <TextAreaField
                key={key}
                label={STRING_LABELS[key]}
                rows={2}
                maxLength={1000}
                disabled={!canEdit}
                placeholder={DEFAULT_PORTAL_STRINGS[key]}
                value={strings[key] ?? ''}
                onChange={(e) => setStrings((s) => ({ ...s, [key]: e.target.value }))}
              />
            ) : (
              <TextField
                key={key}
                label={STRING_LABELS[key]}
                maxLength={1000}
                disabled={!canEdit}
                placeholder={DEFAULT_PORTAL_STRINGS[key]}
                value={strings[key] ?? ''}
                onChange={(e) => setStrings((s) => ({ ...s, [key]: e.target.value }))}
              />
            ),
          )}
        </fieldset>
        <ProblemAlert error={save.error} />
        {canEdit ? (
          <div className="flex justify-end">
            <Button
              variant="primary"
              busy={save.isPending}
              disabled={issues.length > 0 || name.trim() === ''}
              onClick={() => save.mutate()}
            >
              {theme === null ? 'Create theme' : 'Save theme'}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function ColorInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  // Invalid in-progress input is kept locally; valid values flow to the parent.
  const [pending, setPending] = useState<string | null>(null);
  const text = pending ?? value;
  return (
    <div className="flex items-end gap-2">
      <input
        type="color"
        aria-label={`${label} colour picker`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-10 cursor-pointer rounded border border-border"
      />
      <TextField
        label={label}
        value={text}
        disabled={disabled}
        className="flex-1"
        pattern="#[0-9a-fA-F]{6}"
        onChange={(e) => {
          if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
            setPending(null);
            onChange(e.target.value.toLowerCase());
          } else {
            setPending(e.target.value);
          }
        }}
      />
    </div>
  );
}

function TermsEditor({
  orgId,
  portalId,
  canEdit,
}: {
  orgId: string;
  portalId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const key = ['org', orgId, 'captive-portal', portalId, 'terms'];
  const terms = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api('get', '/api/v1/orgs/{orgId}/captive-portals/{id}/terms', {
        params: { orgId, id: portalId },
        signal,
      }) as Promise<TermsList>,
  });
  const [text, setText] = useState('');
  const publish = useMutation({
    mutationFn: () =>
      api('post', '/api/v1/orgs/{orgId}/captive-portals/{id}/terms', {
        params: { orgId, id: portalId },
        body: { texts: { en: text } },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: ['org', orgId] });
    },
  });
  const current = terms.data?.current_version ?? null;
  const currentText = terms.data?.data.find(
    (t) => String(t.version) === current && t.locale === 'en',
  )?.body;

  return (
    <Card title={`Terms of use${current ? ` — version ${current}` : ''}`}>
      <div className="space-y-3">
        {terms.isPending ? <Spinner small label="Loading terms…" /> : null}
        <ProblemAlert error={terms.error} />
        {currentText ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border p-2 text-xs">
            {currentText}
          </pre>
        ) : (
          <p className="text-sm text-subtle">
            No terms published. Click-through login shows the terms.
          </p>
        )}
        {canEdit ? (
          <>
            <TextAreaField
              label="New terms (English)"
              hint="Publishing creates a new immutable version; earlier versions are kept."
              rows={5}
              maxLength={20000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <ProblemAlert error={publish.error} />
            <div className="flex justify-end">
              <Button
                variant="primary"
                busy={publish.isPending}
                disabled={text.trim() === ''}
                onClick={() => publish.mutate()}
              >
                Publish new version
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}

/** Tiny same-tab store: the theme editor publishes its draft, the preview reads it on refresh. */
type Draft = {
  colors: PortalColors;
  strings: Record<string, Strings>;
  logo_asset_id: string | null;
};
const draftStore = (() => {
  let current: Draft | null = null;
  return {
    set: (d: Draft) => {
      current = d;
    },
    get: () => current,
  };
})();

function PreviewPane({
  orgId,
  portalId,
  theme,
}: {
  orgId: string;
  portalId: string;
  theme: Theme | null;
}) {
  const [page, setPage] = useState<PortalPreviewPage>('landing');
  const [locale, setLocale] = useState('en');
  const [url, setUrl] = useState<string | null>(null);
  const preview = useMutation({
    mutationFn: () => {
      const draft = draftStore.get();
      return request<{ preview_url: string }>(
        'post',
        buildUrl('/api/v1/orgs/{orgId}/portal-previews', { orgId }, undefined),
        {
          body: {
            page,
            locale,
            captive_portal_id: portalId,
            ...(theme ? { theme_id: theme.id } : {}),
            ...(draft
              ? {
                  draft: {
                    colors: draft.colors,
                    strings: { ...(theme?.strings ?? {}), ...draft.strings },
                    logo_asset_id: draft.logo_asset_id,
                  },
                }
              : {}),
          },
          pathTemplate: '/api/v1/orgs/{orgId}/portal-previews',
        },
      );
    },
    onSuccess: (res) => setUrl(res.preview_url),
  });
  const { mutate } = preview;
  // Re-render whenever the page or locale changes.
  useEffect(() => {
    mutate();
  }, [page, locale, mutate]);

  return (
    <Card
      title="Preview"
      actions={
        <Button size="sm" busy={preview.isPending} onClick={() => preview.mutate()}>
          Refresh preview
        </Button>
      }
      className="xl:sticky xl:top-4 xl:self-start"
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Page"
            value={page}
            options={PORTAL_PREVIEW_PAGES.map((p) => ({ value: p, label: PAGE_LABELS[p] }))}
            onChange={(e) => setPage(e.target.value as PortalPreviewPage)}
          />
          <SelectField
            label="Language"
            value={locale}
            options={LOCALES}
            onChange={(e) => setLocale(e.target.value)}
          />
        </div>
        <p className="text-xs text-subtle">
          Rendered by the portal page renderer with sample data and your unsaved changes. Forms are
          inactive in the preview.
        </p>
        <ProblemAlert error={preview.error} />
        {url ? (
          <iframe
            title="Portal page preview"
            src={url}
            sandbox=""
            referrerPolicy="no-referrer"
            className="h-[640px] w-full rounded border border-border bg-white"
          />
        ) : (
          <Spinner label="Rendering preview…" />
        )}
      </div>
    </Card>
  );
}
