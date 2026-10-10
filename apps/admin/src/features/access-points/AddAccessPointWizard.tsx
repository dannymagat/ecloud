/**
 * "Add Access Point" wizard (D-045), reusing the existing APIs:
 *   1. Vendor: the logo grid of the setup-guide catalogue.
 *   2. NAS: choose an existing NAS of the vendor's adapter or create one (adapter / post-back
 *      profile preselected from the vendor; `POST …/nas`). A new NAS's RADIUS secret is shown
 *      once (existing behaviour).
 *   3. AP MAC address(es) with a name (validated as the API does; `POST …/access-points`).
 *   4. The vendor's setup guide inline with copy buttons (`GET …/setup-guides/{vendorKey}`).
 *   5. Done: the APs appear in the table as unverified until their first RADIUS request.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Download, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { buildUrl, downloadFile, newIdempotencyKey, request, saveBlob } from '../../api/client';
import { problemOf, type Problem } from '../../api/problem';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { SecretOnce } from '../../components/SecretOnce';
import { Badge, Button, Notice, Spinner, TextField, cx } from '../../components/ui';
import { canonicalUnicastMac, MAC_ADDRESS_RULE } from '../../lib/mac';
import { str } from '../../lib/format';
import type { FieldDef, FormValues } from '../resource/form';
import { toBody } from '../resource/form';
import { ResourceForm } from '../resource/ResourceForm';
import { PostbackProfileField } from '../org/NasPage';
import { useCatalogue } from '../setup-guides/SetupGuidesPage';
import type { CatalogueEntry, VendorGuide } from '../setup-guides/types';
import { EcloudValues, Steps } from '../setup-guides/VendorGuidePage';
import { MIKROTIK_ADAPTER, SCRIPT_PATH, type OverviewNas } from './data';
import { VendorGrid } from './VendorGrid';
import { VendorLogo } from './VendorLogo';

export const WIZARD_STEPS = ['Vendor', 'NAS', 'AP MAC addresses', 'Configure', 'Done'] as const;

const GUIDE_PATH = '/api/v1/orgs/{orgId}/setup-guides/{vendorKey}';
const NAS_PATH = '/api/v1/orgs/{orgId}/nas';
const AP_PATH = '/api/v1/orgs/{orgId}/access-points';
const POSTBACK = 'external-portal-postback';
const MERAKI = 'meraki-splash';

/** NAS form fields of the wizard; adapter / profile / vendor come from step 1. */
export function nasFields(
  adapterKey: string,
  siteId: string | null,
  profile: string | null = null,
): FieldDef[] {
  const fields: FieldDef[] = [
    { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Lobby gateway' },
    {
      name: 'site_id',
      label: 'Site',
      type: 'select',
      required: true,
      optionsFrom: { path: '/api/v1/orgs/{orgId}/sites', label: (r) => str(r.name ?? r.id) },
      ...(siteId !== null ? { defaultValue: siteId } : {}),
    },
  ];
  if (adapterKey !== MERAKI) {
    fields.push({
      name: 'nas_ip',
      label: 'NAS IP',
      type: 'text',
      required: true,
      hint: 'Source IP address of the RADIUS packets from this device (controller, gateway or AP).',
    });
  }
  if (adapterKey === MERAKI) {
    fields.push({
      name: 'das_host',
      label: 'Meraki Disconnect host',
      type: 'text',
      nullable: true,
      hint: 'The nNNN.meraki.com host from your Dashboard URL (Disconnect, UDP 3799).',
    });
  } else {
    fields.push({
      name: 'nas_identifier',
      label: 'NAS-Identifier',
      type: 'text',
      nullable: true,
      required: adapterKey === MIKROTIK_ADAPTER || adapterKey === POSTBACK,
      hint:
        adapterKey === MIKROTIK_ADAPTER
          ? 'The router identity (/system identity); sent as NAS-Identifier.'
          : 'The NAS-Identifier the device sends; requests with another value are rejected.',
    });
  }
  if (adapterKey === POSTBACK) {
    // The existing post-back profile editor, preselected with the vendor's profile (the generic
    // profile of the long-tail vendors needs its parameter names).
    fields.push({
      name: 'adapter_config',
      label: 'External captive portal profile',
      type: 'custom',
      defaultValue: JSON.stringify({ profile: profile ?? 'postback-generic' }),
      render: ({ value, error, onChange }) => (
        <PostbackProfileField value={value} error={error} onChange={onChange} />
      ),
    });
  }
  if (adapterKey === MIKROTIK_ADAPTER) {
    fields.push(
      {
        name: 'hotspot_address',
        label: 'Hotspot address',
        type: 'text',
        required: true,
        hint: 'The router HotSpot interface IP (private IPv4): the host of its login page.',
      },
      {
        name: 'hotspot_port',
        label: 'Hotspot port',
        type: 'number',
        min: 1,
        max: 65535,
        nullable: true,
        hint: 'Only when the login page is not on 80 / 443.',
      },
    );
  }
  return fields;
}

export interface MacRow {
  key: number;
  mac: string;
  name: string;
  error?: string;
  /** Created access point id once saved. */
  savedId?: string;
}

/** Client-side check of the AP rows (format, unicast, duplicates, name length). */
export function validateMacRows(rows: readonly MacRow[]): MacRow[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    if (r.savedId !== undefined) return { ...r, error: undefined };
    const mac = canonicalUnicastMac(r.mac);
    let error: string | undefined;
    if (r.mac.trim() === '') error = 'Enter the AP MAC address.';
    else if (mac === null) error = `Must be ${MAC_ADDRESS_RULE}.`;
    else if (seen.has(mac)) error = 'This MAC address is listed twice.';
    else if (r.name.trim().length > 200) error = 'The name is at most 200 characters.';
    if (mac !== null) seen.add(mac);
    return { ...r, error };
  });
}

function StepIndicator({ step }: { step: number }) {
  return (
    <ol aria-label="Wizard steps" className="mb-4 flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {WIZARD_STEPS.map((label, i) => (
        <li
          key={label}
          aria-current={i === step ? 'step' : undefined}
          className={cx(
            'inline-flex items-center gap-1.5',
            i === step ? 'font-semibold text-fg' : i < step ? 'text-success' : 'text-subtle',
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              'flex h-5 w-5 items-center justify-center rounded-full border text-[0.7rem]',
              i === step
                ? 'border-primary bg-primary text-primary-fg'
                : i < step
                  ? 'border-success text-success'
                  : 'border-border',
            )}
          >
            {i + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

export function AddAccessPointWizard({
  open,
  orgId,
  siteId,
  nas,
  initialVendor = null,
  onClose,
}: {
  open: boolean;
  orgId: string;
  siteId: string | null;
  nas: readonly OverviewNas[];
  initialVendor?: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const catalogue = useCatalogue(orgId);
  const [step, setStep] = useState(0);
  const [vendorKey, setVendorKey] = useState<string | null>(initialVendor);
  const [nasMode, setNasMode] = useState<'existing' | 'new'>('existing');
  const [nasId, setNasId] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; secret: string } | null>(null);
  const [secretStored, setSecretStored] = useState(false);
  const [nasProblem, setNasProblem] = useState<Problem | null>(null);
  const [nasKey, setNasKey] = useState(newIdempotencyKey);
  const [rows, setRows] = useState<MacRow[]>([{ key: 1, mac: '', name: '' }]);
  const [apBusy, setApBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<unknown>(null);

  const entries = catalogue.data?.data ?? [];
  const vendor: CatalogueEntry | null = entries.find((e) => e.vendor_key === vendorKey) ?? null;
  const candidates = useMemo(
    () => (vendor === null ? [] : nas.filter((n) => n.adapter_key === vendor.adapter_key)),
    [nas, vendor],
  );
  const effectiveMode = candidates.length === 0 ? 'new' : nasMode;
  const chosenNas: { id: string; name: string } | null =
    created ??
    (effectiveMode === 'existing'
      ? (candidates.find((n) => n.id === nasId) ?? candidates[0] ?? null)
      : null);

  const guideSite = siteId;
  const guide = useQuery({
    queryKey: ['org', orgId, 'setup-guides', vendorKey, guideSite],
    enabled: open && vendorKey !== null && step >= 3,
    retry: false,
    queryFn: () =>
      request<VendorGuide>(
        'get',
        buildUrl(
          GUIDE_PATH,
          { orgId, vendorKey: vendorKey ?? '' },
          guideSite === null ? undefined : { site_id: guideSite },
        ),
        { pathTemplate: GUIDE_PATH },
      ),
  });

  const createNas = useMutation({
    gcTime: 0,
    mutationFn: (body: Record<string, unknown>) =>
      request<Record<string, unknown>>('post', buildUrl(NAS_PATH, { orgId }, undefined), {
        body,
        idempotencyKey: nasKey,
        pathTemplate: NAS_PATH,
      }),
    onSuccess: (row) => {
      setNasKey(newIdempotencyKey());
      void qc.invalidateQueries({ queryKey: ['org', orgId] });
      setCreated({
        id: String(row.id),
        name: typeof row.name === 'string' ? row.name : '',
        secret: typeof row.secret === 'string' ? row.secret : '',
      });
      // The mutation state also holds the response (with the secret): drop it at once.
      createNas.reset();
    },
    onError: (e) => setNasProblem(problemOf(e)),
  });

  const reset = () => {
    setStep(0);
    setVendorKey(initialVendor);
    setNasMode('existing');
    setNasId(null);
    setCreated(null);
    setSecretStored(false);
    setNasProblem(null);
    setRows([{ key: 1, mac: '', name: '' }]);
    setDownloadError(null);
    createNas.reset();
  };
  const close = () => {
    void qc.invalidateQueries({ queryKey: ['org', orgId] });
    reset();
    onClose();
  };
  // Dialog re-runs its focus effect when onClose changes identity: keep it stable so typing in
  // the wizard does not move the focus.
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  const stableClose = useCallback(() => closeRef.current(), []);

  const saveAps = async () => {
    const checked = validateMacRows(rows);
    setRows(checked);
    if (checked.some((r) => r.error !== undefined) || chosenNas === null) return;
    setApBusy(true);
    const next: MacRow[] = [];
    for (const r of checked) {
      if (r.savedId !== undefined) {
        next.push(r);
        continue;
      }
      try {
        const res = await request<Record<string, unknown>>(
          'post',
          buildUrl(AP_PATH, { orgId }, undefined),
          {
            body: {
              nas_client_id: chosenNas.id,
              mac: canonicalUnicastMac(r.mac),
              ...(r.name.trim() !== '' ? { name: r.name.trim() } : {}),
            },
            pathTemplate: AP_PATH,
          },
        );
        next.push({ ...r, savedId: String(res.id), error: undefined });
      } catch (e) {
        const p = problemOf(e);
        next.push({
          ...r,
          error:
            p.status === 409
              ? 'This MAC address is already registered (here or in another organization).'
              : (p.errors?.[0]?.message ?? p.detail ?? p.title),
        });
      }
    }
    setRows(next);
    setApBusy(false);
    void qc.invalidateQueries({ queryKey: ['org', orgId] });
    if (next.every((r) => r.savedId !== undefined)) setStep(3);
  };

  const downloadScript = async () => {
    if (chosenNas === null) return;
    setDownloadError(null);
    try {
      const { blob, filename } = await downloadFile(
        'get',
        buildUrl(SCRIPT_PATH, { orgId, id: chosenNas.id }, undefined),
      );
      saveBlob(blob, filename ?? 'ecloud-mikrotik.rsc');
    } catch (e) {
      setDownloadError(e);
    }
  };

  const savedCount = rows.filter((r) => r.savedId !== undefined).length;
  const nasFormFields =
    vendor === null ? [] : nasFields(vendor.adapter_key, siteId, vendor.profile);

  let body: ReactNode = null;
  if (step === 0) {
    body = (
      <section aria-labelledby="wiz-vendor" className="space-y-3">
        <h3 id="wiz-vendor" className="text-sm font-semibold">
          Which access points or gateway do you use?
        </h3>
        <ProblemAlert error={catalogue.error} />
        {catalogue.isPending ? (
          <Spinner label="Loading vendors" />
        ) : (
          <VendorGrid
            entries={entries}
            label="Choose a vendor"
            selected={vendorKey}
            onSelect={(e) => {
              setVendorKey(e.vendor_key);
              setNasId(null);
            }}
          />
        )}
      </section>
    );
  } else if (step === 1 && vendor !== null) {
    body = (
      <section aria-labelledby="wiz-nas" className="space-y-3">
        <h3 id="wiz-nas" className="text-sm font-semibold">
          RADIUS client (NAS) for {vendor.display_name}
        </h3>
        <p className="text-xs text-subtle">
          Adapter <code>{vendor.adapter_key}</code>
          {vendor.profile !== null ? (
            <>
              {' '}
              · profile <code>{vendor.profile}</code>
            </>
          ) : null}
          . The NAS is the device that sends RADIUS to ECLOUD (controller, gateway or the AP).
        </p>
        {created !== null ? (
          secretStored ? (
            <Notice tone="success" title={`NAS ${created.name} created`}>
              Continue to register its access points.
            </Notice>
          ) : (
            <SecretOnce
              title="RADIUS shared secret"
              value={created.secret}
              description="Configure this on the device. An organization admin can reveal it later on this page."
              onDone={() => {
                // The secret leaves component state once it is acknowledged (never shown again).
                setCreated((c) => (c === null ? c : { ...c, secret: '' }));
                setSecretStored(true);
              }}
            />
          )
        ) : (
          <>
            {candidates.length > 0 ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Use</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="nas-mode"
                    checked={effectiveMode === 'existing'}
                    onChange={() => setNasMode('existing')}
                  />
                  An existing NAS
                </label>
                {effectiveMode === 'existing' ? (
                  <select
                    aria-label="Existing NAS"
                    value={chosenNas?.id ?? ''}
                    onChange={(e) => setNasId(e.target.value)}
                    className="ms-6 block w-full max-w-md rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  >
                    {candidates.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} ({n.site_name})
                      </option>
                    ))}
                  </select>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="nas-mode"
                    checked={effectiveMode === 'new'}
                    onChange={() => setNasMode('new')}
                  />
                  A new NAS
                </label>
              </fieldset>
            ) : null}
            {effectiveMode === 'new' ? (
              <ResourceForm
                key={vendor.vendor_key}
                orgId={orgId}
                fields={nasFormFields}
                mode="create"
                submitLabel="Create NAS"
                busy={createNas.isPending}
                problem={nasProblem}
                onCancel={() => setStep(0)}
                onSubmit={(values: FormValues) => {
                  setNasProblem(null);
                  createNas.mutate({
                    ...toBody(nasFormFields, values, 'create'),
                    adapter_key: vendor.adapter_key,
                    vendor_key: vendor.vendor_key,
                  });
                }}
              />
            ) : null}
          </>
        )}
      </section>
    );
  } else if (step === 2 && chosenNas !== null) {
    body = (
      <section aria-labelledby="wiz-macs" className="space-y-3">
        <h3 id="wiz-macs" className="text-sm font-semibold">
          Access points behind {chosenNas.name}
        </h3>
        <p className="text-xs text-subtle">
          The MAC address as the vendor sends it in the portal redirect. Each AP stays
          &quot;unverified&quot; until ECLOUD sees its first RADIUS request.
        </p>
        <ul className="space-y-2" aria-label="AP MAC addresses">
          {rows.map((r, i) => (
            <li
              key={r.key}
              className="grid grid-cols-1 gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_auto] sm:items-start"
            >
              <TextField
                label={`MAC address ${String(i + 1)}`}
                value={r.mac}
                required
                placeholder="aa:bb:cc:dd:ee:ff"
                autoComplete="off"
                spellCheck={false}
                disabled={r.savedId !== undefined}
                error={r.error}
                onChange={(e) =>
                  setRows((all) =>
                    all.map((x) =>
                      x.key === r.key ? { ...x, mac: e.target.value, error: undefined } : x,
                    ),
                  )
                }
              />
              <TextField
                label={`Name ${String(i + 1)}`}
                value={r.name}
                maxLength={200}
                placeholder="Lobby AP"
                disabled={r.savedId !== undefined}
                onChange={(e) =>
                  setRows((all) =>
                    all.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)),
                  )
                }
              />
              <div className="flex items-center gap-2 sm:pt-6">
                {r.savedId !== undefined ? (
                  <Badge tone="success">Saved</Badge>
                ) : rows.length > 1 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove MAC address ${String(i + 1)}`}
                    onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          onClick={() =>
            setRows((all) => [
              ...all,
              { key: Math.max(0, ...all.map((x) => x.key)) + 1, mac: '', name: '' },
            ])
          }
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Add another AP
        </Button>
      </section>
    );
  } else if (step === 3) {
    const g = guide.data;
    body = (
      <section aria-labelledby="wiz-guide" className="space-y-3">
        <h3 id="wiz-guide" className="text-sm font-semibold">
          Configure your {vendor?.display_name ?? 'device'}
        </h3>
        <ProblemAlert error={guide.error} />
        {guide.isPending ? <Spinner label="Loading the setup guide" /> : null}
        {vendor?.adapter_key === MIKROTIK_ADAPTER && chosenNas !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void downloadScript()}>
              <Download aria-hidden="true" className="h-3.5 w-3.5" />
              Download MikroTik installation script
            </Button>
            <span className="text-xs text-subtle">
              Paste the RADIUS secret into the script before running it.
            </span>
          </div>
        ) : null}
        <ProblemAlert error={downloadError} />
        {g ? (
          <div className="space-y-3">
            <EcloudValues guide={g} />
            <Steps guide={g} />
          </div>
        ) : null}
        {vendorKey !== null ? (
          <Link
            to={`/orgs/${orgId}/setup-guides/${vendorKey}`}
            className="inline-block text-sm font-medium text-primary underline underline-offset-2"
          >
            Open the full setup guide
          </Link>
        ) : null}
      </section>
    );
  } else if (step === 4) {
    body = (
      <section aria-labelledby="wiz-done" className="space-y-3">
        <h3 id="wiz-done" className="text-sm font-semibold">
          Done
        </h3>
        <Notice tone="success" title="Access points added">
          {savedCount === 0
            ? 'No AP MAC address was registered; you can add them later.'
            : `${String(savedCount)} access point${savedCount === 1 ? '' : 's'} added behind ${chosenNas?.name ?? 'the NAS'}.`}{' '}
          They show as unverified until ECLOUD receives their first RADIUS request.
        </Notice>
      </section>
    );
  }

  const canNext =
    (step === 0 && vendor !== null) ||
    (step === 1 && chosenNas !== null && (created === null || secretStored)) ||
    step === 3;

  return (
    <Dialog open={open} title="Add Access Point" onClose={stableClose} wide>
      <StepIndicator step={step} />
      {vendor !== null && step > 0 ? (
        <div className="mb-3 flex items-center gap-2 text-sm">
          <VendorLogo
            vendorKey={vendor.vendor_key}
            name={vendor.display_name}
            size="sm"
            decorative
          />
          <span className="font-medium">{vendor.display_name}</span>
        </div>
      ) : null}
      {body}
      <div className="mt-4 flex flex-wrap justify-between gap-2 border-t border-border pt-3">
        <div>
          {step > 0 && step < 4 ? (
            <Button onClick={() => setStep((s) => s - 1)} disabled={step === 1 && created !== null}>
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              Back
            </Button>
          ) : null}
        </div>
        <div className="flex gap-2">
          {step === 2 ? (
            <>
              <Button onClick={() => setStep(3)}>Skip</Button>
              <Button variant="primary" busy={apBusy} onClick={() => void saveAps()}>
                Save and continue
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </>
          ) : step === 4 ? (
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          ) : (
            <Button variant="primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              Next
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
