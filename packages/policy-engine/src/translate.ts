/**
 * Translation layer (POLICY_ENGINE.md §4): effective intent + adapter capabilities → enforcement
 * plan. Only attributes the adapter declares VERIFIED_SUPPORTED are emitted; REQUIRES_DEVICE_TEST
 * attributes are emitted solely when `context.includeDeviceTestAttributes` is true (lab use) and
 * are then marked `experimental`. Anything the adapter cannot express is listed, never dropped.
 */
import { POLICY_FIELDS, type AdapterFieldStatus, type PolicyField } from '@ecloud/shared';
import {
  type AdapterCapabilities,
  type AdapterKey,
  type RadiusVendor,
  type RateAttrFamily,
  type RateFamilyDeclaration,
} from './capabilities.js';
import { MIN_TIMEOUT_S, RADIUS_UINT32_MAX } from './intent.js';
import type { IntentColumn } from './intent.js';
import type { Clip, EcloudSideControl, EffectivePolicy, Provenance } from './resolve.js';

export const DEGRADATION_MODES = [
  'fallback_ecloud_side',
  'allow_and_flag',
  'strict_reject',
] as const;
export type DegradationMode = (typeof DEGRADATION_MODES)[number];

export type PlanField = PolicyField | 'interim_interval' | 'class' | 'session_bound';

export interface TranslationContext {
  /** ECLOUD session id → `Class = ecloud:<id>` (§4.1). Omit to skip `Class`. */
  readonly sessionId?: string | null;
  readonly now?: Date;
  readonly clip: Clip;
  /** Controls armed by resolution; copied into the plan. */
  readonly controls?: readonly EcloudSideControl[];
  /** Q8 default WISPr. */
  readonly preferredRateAttrFamily?: RateAttrFamily;
  /** `tenant.interim_interval_s`; null/undefined = do not emit `Acct-Interim-Interval`. */
  readonly interimIntervalS?: number | null;
  /** uspot only honours `Acct-Interim-Interval` when the NAS `acct-interval` is unset (A4 §3.4). */
  readonly nasAcctIntervalUnset?: boolean;
  readonly degradation?: DegradationMode;
  /** Lab mode: also emit REQUIRES_DEVICE_TEST attributes (marked `experimental`). */
  readonly includeDeviceTestAttributes?: boolean;
  /** SSID label for `openwifi-config` paths; `ssidIsCaptive` gates `captive.*` keys. */
  readonly ssidRef?: string;
  readonly ssidIsCaptive?: boolean;
}

export interface ReplyAttribute {
  readonly name: string;
  readonly value: string | number;
  readonly vendor?: RadiusVendor;
  readonly status: AdapterFieldStatus;
  readonly field: PlanField;
  readonly evidence: string;
  readonly experimental?: true;
}

export type UnenforceableReason =
  | 'unsupported'
  | 'requires_device_test'
  | 'granularity_mismatch'
  | 'overflow_clamped'
  | 'attribute_not_declared';

export interface Unenforceable {
  readonly field: PlanField;
  readonly status: AdapterFieldStatus;
  readonly reason: UnenforceableReason;
  readonly detail?: string;
}

export interface ConfigPushChange {
  readonly path: string;
  readonly value: string | number | boolean;
  readonly scope: 'ssid';
  readonly status: AdapterFieldStatus;
  readonly evidence: string;
  readonly field: PolicyField;
}

export type Mechanism = 'radius' | 'config_push' | 'ecloud_side' | 'none' | 'not_set';

export interface FieldEnforceability {
  readonly field: PolicyField;
  readonly set: boolean;
  readonly status: AdapterFieldStatus;
  readonly evidence: string;
  readonly mechanism: Mechanism;
  readonly attributes: readonly string[];
  /** True only when the field is set, VERIFIED_SUPPORTED and actually emitted (D-028). */
  readonly deviceEnforced: boolean;
  readonly detail?: string;
}

export interface SessionTimeoutDerivation {
  readonly value: number | null;
  readonly boundBy: string | null;
  readonly candidates: Readonly<Record<string, number>>;
}

export interface EnforcementPlan {
  readonly adapter: AdapterKey;
  readonly adapterVersion: string;
  readonly decision: 'accept' | 'reject';
  readonly reasonCode: string | null;
  readonly radiusReplyAttributes: readonly ReplyAttribute[];
  readonly ecloudSideControls: readonly EcloudSideControl[];
  readonly configPushChanges: readonly ConfigPushChange[];
  readonly unenforceable: readonly Unenforceable[];
  readonly fieldTable: readonly FieldEnforceability[];
  readonly degradation: DegradationMode;
  readonly sessionTimeout: SessionTimeoutDerivation;
}

export const TUNNEL_TYPE_VLAN = 13;
export const TUNNEL_MEDIUM_IEEE_802 = 6;
const TWO_POW_32 = 4_294_967_296n;

function isSiteScoped(p: Provenance | undefined): boolean {
  return p?.target_type === 'site' || p?.target_type === 'organization_default';
}

class PlanBuilder {
  readonly attrs: ReplyAttribute[] = [];
  readonly unenforceable: Unenforceable[] = [];
  readonly config: ConfigPushChange[] = [];
  readonly controls: EcloudSideControl[] = [];
  readonly emittedFor = new Map<PlanField, string[]>();
  readonly details = new Map<PlanField, string>();

  constructor(
    readonly adapter: AdapterCapabilities,
    readonly ctx: TranslationContext,
  ) {}

  private note(field: PlanField, name: string): void {
    const list = this.emittedFor.get(field) ?? [];
    list.push(name);
    this.emittedFor.set(field, list);
  }

  flag(
    field: PlanField,
    reason: UnenforceableReason,
    detail?: string,
    status?: AdapterFieldStatus,
  ): void {
    const st =
      status ??
      (field in this.adapter.fields
        ? this.adapter.fields[field as PolicyField].status
        : 'UNSUPPORTED');
    this.unenforceable.push(
      detail ? { field, status: st, reason, detail } : { field, status: st, reason },
    );
    if (detail) this.details.set(field, detail);
  }

  /** Gate every attribute through the adapter's attribute declaration (D-028). */
  emit(name: string, value: string | number, field: PlanField, vendor?: RadiusVendor): boolean {
    const decl = this.adapter.attributes[name];
    if (!decl) {
      this.flag(field, 'attribute_not_declared', `${name} is not declared by ${this.adapter.key}`);
      return false;
    }
    const base = {
      name,
      value,
      status: decl.status,
      field,
      evidence: decl.evidence,
      ...(vendor ? { vendor } : {}),
    };
    if (decl.status === 'VERIFIED_SUPPORTED') {
      this.attrs.push(base);
      this.note(field, name);
      return true;
    }
    if (decl.status === 'REQUIRES_DEVICE_TEST') {
      if (this.ctx.includeDeviceTestAttributes === true) {
        this.attrs.push({ ...base, experimental: true });
        this.note(field, name);
      }
      this.flag(
        field,
        'requires_device_test',
        `${name}: ${decl.note ?? decl.evidence}`,
        decl.status,
      );
      return false;
    }
    this.flag(field, 'unsupported', `${name}: ${decl.note ?? decl.evidence}`, decl.status);
    return false;
  }

  pushConfig(
    path: string,
    value: string | number | boolean,
    field: PolicyField,
    evidence: string,
  ): void {
    this.config.push({
      path,
      value,
      scope: 'ssid',
      status: this.adapter.fields[field].status,
      evidence,
      field,
    });
    this.note(field, path);
  }
}

function chooseRateFamily(
  adapter: AdapterCapabilities,
  preferred: RateAttrFamily,
): RateFamilyDeclaration | null {
  return (
    adapter.rateFamilies.find((f) => f.family === preferred) ?? adapter.rateFamilies[0] ?? null
  );
}

function rateValue(
  kbps: number,
  unit: RateFamilyDeclaration['unit'],
): { value: number; clamped: boolean } {
  if (unit === 'bps') {
    const bps = kbps * 1000;
    return bps > RADIUS_UINT32_MAX
      ? { value: RADIUS_UINT32_MAX, clamped: true }
      : { value: bps, clamped: false };
  }
  return { value: kbps, clamped: false };
}

function translateRates(b: PlanBuilder, eff: EffectivePolicy, degradation: DegradationMode): void {
  const adapter = b.adapter;
  const ssid = b.ctx.ssidRef ?? '<ssid>';
  const pairs: [IntentColumn, number | null, 'down' | 'up'][] = [
    ['download_rate_kbps', eff.fields.download_rate_kbps, 'down'],
    ['upload_rate_kbps', eff.fields.upload_rate_kbps, 'up'],
  ];
  const family = chooseRateFamily(adapter, b.ctx.preferredRateAttrFamily ?? 'wispr');
  for (const [field, kbps, dir] of pairs) {
    if (kbps === null) continue;
    const decl = adapter.fields[field];
    if (adapter.granularity === 'per-ssid') {
      if (!isSiteScoped(eff.provenance[field])) {
        b.flag(
          field,
          'granularity_mismatch',
          `per-SSID rate-limit would cap every station; winning layer is ${eff.provenance[field]?.layer_name ?? 'unknown'}`,
        );
        continue;
      }
      if (decl.status !== 'VERIFIED_SUPPORTED') {
        b.flag(
          field,
          decl.status === 'REQUIRES_DEVICE_TEST' ? 'requires_device_test' : 'unsupported',
          decl.note ?? decl.evidence,
        );
        continue;
      }
      if (kbps < 1000) {
        b.flag(
          field,
          'unsupported',
          `sub-Mbit: ${kbps} kbps cannot be expressed as an integer Mbit/s rate-limit (A2 §7.3)`,
        );
        continue;
      }
      // ingress = client upload, egress = client download (A2 §7.3; end-to-end direction REQUIRES DEVICE TEST).
      const key = dir === 'down' ? 'egress-rate' : 'ingress-rate';
      b.pushConfig(
        `interfaces[].ssids[${ssid}].rate-limit.${key}`,
        Math.ceil(kbps / 1000),
        field,
        decl.evidence,
      );
      continue;
    }
    if (decl.status !== 'VERIFIED_SUPPORTED' || !family) {
      const reason: UnenforceableReason =
        decl.status === 'REQUIRES_DEVICE_TEST' ? 'requires_device_test' : 'unsupported';
      b.flag(field, reason, decl.note ?? decl.evidence);
      if (degradation === 'fallback_ecloud_side' && isSiteScoped(eff.provenance[field])) {
        b.controls.push({
          kind: 'config_push_fallback',
          params: {
            adapter: 'openwifi-config',
            field,
            kbps,
            reason: 'site-scoped rate on an adapter without a verified per-client rate attribute',
          },
        });
      }
      continue;
    }
    const { value, clamped } = rateValue(kbps, family.unit);
    const name = dir === 'down' ? family.down : family.up;
    if (b.emit(name, value, field, family.vendor) && clamped) {
      b.flag(
        field,
        'overflow_clamped',
        `${name} clamped to ${RADIUS_UINT32_MAX} bit/s`,
        decl.status,
      );
    }
  }
}

function translateBurst(b: PlanBuilder, eff: EffectivePolicy): void {
  for (const field of ['burst_download_kbps', 'burst_upload_kbps', 'burst_duration_s'] as const) {
    if (eff.fields[field] === null) continue;
    const decl = b.adapter.fields[field];
    b.flag(
      field,
      decl.status === 'REQUIRES_DEVICE_TEST' ? 'requires_device_test' : 'unsupported',
      decl.note ?? decl.evidence,
    );
  }
}

/** Returns true when a verified octet limit was emitted (then the drain-time bound is not needed). */
function translateQuota(b: PlanBuilder, eff: EffectivePolicy): boolean {
  const quotaFields = (
    ['quota_daily_bytes', 'quota_monthly_bytes', 'quota_total_bytes'] as const
  ).filter((f) => eff.fields[f] !== null);
  if (quotaFields.length === 0) return false;
  const remaining = b.ctx.clip.remaining_octets;
  const adapter = b.adapter;
  const primary = quotaFields[0] as PolicyField;
  const decl = adapter.fields[primary];
  if (
    decl.status !== 'VERIFIED_SUPPORTED' ||
    !adapter.quotaAttributes.total ||
    adapter.octetWidth === null
  ) {
    for (const f of quotaFields) {
      const d = adapter.fields[f];
      const reason: UnenforceableReason =
        d.status === 'REQUIRES_DEVICE_TEST'
          ? 'requires_device_test'
          : d.status === 'UNSUPPORTED' || d.status === 'ECLOUD_SIDE_ONLY'
            ? 'unsupported'
            : 'unsupported';
      b.flag(
        f,
        reason,
        d.note ?? 'no octet attribute; bounded by Session-Timeout drain time + accounting watcher',
      );
    }
    return false;
  }
  if (remaining === null) return false;
  const vendor = adapter.attributes[adapter.quotaAttributes.total]?.vendor;
  let emitted = false;
  if (adapter.octetWidth === 32) {
    const clamped = remaining > BigInt(RADIUS_UINT32_MAX);
    const value = clamped ? RADIUS_UINT32_MAX : Number(remaining);
    emitted = b.emit(adapter.quotaAttributes.total, value, primary, vendor);
    if (emitted && clamped) {
      b.flag(
        primary,
        'overflow_clamped',
        `${adapter.quotaAttributes.total} is 32-bit; ${remaining} clamped to ${RADIUS_UINT32_MAX}, watcher covers the remainder`,
        decl.status,
      );
    }
  } else {
    const octets = Number(remaining % TWO_POW_32);
    const giga = Number(remaining / TWO_POW_32);
    emitted = b.emit(adapter.quotaAttributes.total, octets, primary, vendor);
    if (adapter.quotaAttributes.totalGigawords) {
      b.emit(adapter.quotaAttributes.totalGigawords, giga, primary, vendor);
    }
  }
  for (const f of quotaFields.slice(1)) {
    const list = b.emittedFor.get(primary) ?? [];
    b.emittedFor.set(f, [...list]);
  }
  return emitted;
}

function deriveSessionTimeout(
  clip: Clip,
  verifiedOctetLimit: boolean,
  degradation: DegradationMode,
): SessionTimeoutDerivation {
  const candidates: Record<string, number> = {};
  if (clip.policy_session_timeout_s !== null)
    candidates.policy = Math.max(MIN_TIMEOUT_S, clip.policy_session_timeout_s);
  if (clip.window_end_s !== null)
    candidates.window_end = Math.max(MIN_TIMEOUT_S, clip.window_end_s);
  if (clip.validity_end_s !== null)
    candidates.validity_end = Math.max(MIN_TIMEOUT_S, clip.validity_end_s);
  if (clip.voucher_end_s !== null)
    candidates.voucher_end = Math.max(MIN_TIMEOUT_S, clip.voucher_end_s);
  if (clip.quota_reset_s !== null)
    candidates.quota_reset = Math.max(MIN_TIMEOUT_S, clip.quota_reset_s);
  if (clip.drain_time_s !== null && !verifiedOctetLimit && degradation === 'fallback_ecloud_side') {
    candidates.quota_drain = Math.max(clip.min_session_s, clip.drain_time_s);
  }
  let value: number | null = null;
  let boundBy: string | null = null;
  for (const [key, v] of Object.entries(candidates)) {
    if (value === null || v < value) {
      value = v;
      boundBy = key;
    }
  }
  return { value, boundBy, candidates };
}

function translateTimers(b: PlanBuilder, eff: EffectivePolicy, st: SessionTimeoutDerivation): void {
  const adapter = b.adapter;
  const ssid = b.ctx.ssidRef ?? '<ssid>';
  const sessionSet = eff.fields.session_timeout_s !== null;
  if (adapter.granularity === 'per-ssid') {
    if (sessionSet) {
      const decl = adapter.fields.session_timeout_s;
      if (!isSiteScoped(eff.provenance.session_timeout_s))
        b.flag(
          'session_timeout_s',
          'granularity_mismatch',
          'per-SSID captive.session-timeout is a NAS default, not per client',
        );
      else if (decl.status !== 'VERIFIED_SUPPORTED')
        b.flag('session_timeout_s', 'requires_device_test', decl.note ?? decl.evidence);
      else if (b.ctx.ssidIsCaptive !== true)
        b.flag(
          'session_timeout_s',
          'unsupported',
          'captive.session-timeout applies to captive SSIDs only; no per-SSID session timeout key for 802.1X SSIDs (A2 §2)',
        );
      else
        b.pushConfig(
          `interfaces[].ssids[${ssid}].captive.session-timeout`,
          eff.fields.session_timeout_s as number,
          'session_timeout_s',
          decl.evidence,
        );
    }
    if (eff.fields.idle_timeout_s !== null) {
      const decl = adapter.fields.idle_timeout_s;
      if (!isSiteScoped(eff.provenance.idle_timeout_s))
        b.flag(
          'idle_timeout_s',
          'granularity_mismatch',
          'per-SSID max-inactivity is a NAS default, not per client',
        );
      else if (decl.status !== 'VERIFIED_SUPPORTED')
        b.flag('idle_timeout_s', 'requires_device_test', decl.note ?? decl.evidence);
      else
        b.pushConfig(
          `interfaces[].ssids[${ssid}].max-inactivity`,
          eff.fields.idle_timeout_s,
          'idle_timeout_s',
          decl.evidence,
        );
    }
    return;
  }
  if (st.value !== null) {
    if (adapter.sessionTimeoutAttr)
      b.emit(
        adapter.sessionTimeoutAttr,
        st.value,
        sessionSet ? 'session_timeout_s' : 'session_bound',
      );
    else
      b.flag(
        sessionSet ? 'session_timeout_s' : 'session_bound',
        'unsupported',
        'adapter has no Session-Timeout attribute',
      );
  }
  if (eff.fields.idle_timeout_s !== null) {
    if (adapter.idleTimeoutAttr)
      b.emit(
        adapter.idleTimeoutAttr,
        Math.max(MIN_TIMEOUT_S, eff.fields.idle_timeout_s),
        'idle_timeout_s',
      );
    else
      b.flag(
        'idle_timeout_s',
        'unsupported',
        adapter.fields.idle_timeout_s.note ?? adapter.fields.idle_timeout_s.evidence,
      );
  }
}

function translateInterim(b: PlanBuilder): void {
  const v = b.ctx.interimIntervalS;
  if (v === null || v === undefined) return;
  const adapter = b.adapter;
  if (!adapter.interimIntervalAttr) return;
  const value = Math.max(MIN_TIMEOUT_S, v);
  const emitted = b.emit(adapter.interimIntervalAttr, value, 'interim_interval');
  const decl = adapter.attributes[adapter.interimIntervalAttr];
  if (
    emitted &&
    decl?.note &&
    b.ctx.nasAcctIntervalUnset !== true &&
    (adapter.key === 'openwifi-uspot-uam' || adapter.key === 'uspot-upstream-uam')
  ) {
    b.flag(
      'interim_interval',
      'requires_device_test',
      `honoured only if NAS acct-interval unset (A4 §3.4); renderer default injection REQUIRES DEVICE TEST (A4 §10 item 5)`,
      decl.status,
    );
  }
}

function translateVlan(b: PlanBuilder, eff: EffectivePolicy): void {
  const vlan = eff.fields.vlan_id;
  if (vlan === null) return;
  const adapter = b.adapter;
  const decl = adapter.fields.vlan_id;
  if (
    adapter.vlanAttrs.length === 0 ||
    decl.status === 'UNSUPPORTED' ||
    decl.status === 'ECLOUD_SIDE_ONLY'
  ) {
    b.flag('vlan_id', 'unsupported', decl.note ?? decl.evidence);
    return;
  }
  // RFC 3580 triplet (hostapd) or CoovaChilli-VLAN-Id; attribute gate decides emission.
  for (const name of adapter.vlanAttrs) {
    const value =
      name === 'Tunnel-Type'
        ? TUNNEL_TYPE_VLAN
        : name === 'Tunnel-Medium-Type'
          ? TUNNEL_MEDIUM_IEEE_802
          : name === 'Tunnel-Private-Group-Id'
            ? String(vlan)
            : vlan;
    b.emit(name, value, 'vlan_id', adapter.attributes[name]?.vendor);
  }
  // One consolidated flag per field (emit() flags per attribute; keep the first, drop duplicates).
  const seen = new Set<string>();
  for (let i = b.unenforceable.length - 1; i >= 0; i--) {
    const u = b.unenforceable[i];
    if (u && u.field === 'vlan_id') {
      if (seen.has(u.reason)) b.unenforceable.splice(i, 1);
      else seen.add(u.reason);
    }
  }
}

function translateEcloudSideFields(b: PlanBuilder, eff: EffectivePolicy): void {
  const set: Record<string, boolean> = {
    max_concurrent_sessions: eff.fields.max_concurrent_sessions !== null,
    max_devices: eff.fields.max_devices !== null,
    valid_from: eff.fields.valid_from !== null,
    valid_until: eff.fields.valid_until !== null,
    voucher_validity: b.ctx.clip.voucher_end_s !== null,
    schedule_id: eff.schedule !== null,
  };
  for (const [field, isSet] of Object.entries(set) as [PolicyField, boolean][]) {
    if (!isSet) continue;
    const decl = b.adapter.fields[field];
    if (decl.status === 'ECLOUD_SIDE_ONLY') continue; // enforced by resolution + controls
    b.flag(
      field,
      decl.status === 'REQUIRES_DEVICE_TEST'
        ? 'requires_device_test'
        : decl.status === 'UNSUPPORTED'
          ? 'unsupported'
          : 'granularity_mismatch',
      decl.note ?? decl.evidence,
    );
  }
}

function isFieldSet(eff: EffectivePolicy, clip: Clip, field: PolicyField): boolean {
  if (field === 'voucher_validity') return clip.voucher_end_s !== null;
  if (field === 'schedule_id') return eff.schedule !== null;
  return eff.fields[field] !== null;
}

function buildFieldTable(b: PlanBuilder, eff: EffectivePolicy): FieldEnforceability[] {
  return POLICY_FIELDS.map((field) => {
    const decl = b.adapter.fields[field];
    const set = isFieldSet(eff, b.ctx.clip, field);
    const attributes = b.emittedFor.get(field) ?? [];
    const flagged = b.unenforceable.some((u) => u.field === field);
    let mechanism: Mechanism;
    if (!set) mechanism = 'not_set';
    else if (attributes.some((a) => a.includes('.'))) mechanism = 'config_push';
    else if (attributes.length > 0) mechanism = 'radius';
    else if (decl.status === 'ECLOUD_SIDE_ONLY') mechanism = 'ecloud_side';
    else mechanism = 'none';
    const deviceEnforced =
      set &&
      decl.status === 'VERIFIED_SUPPORTED' &&
      attributes.length > 0 &&
      !b.unenforceable.some((u) => u.field === field && u.reason !== 'overflow_clamped');
    const detail = b.details.get(field);
    return {
      field,
      set,
      status: decl.status,
      evidence: decl.evidence,
      mechanism,
      attributes,
      deviceEnforced,
      ...(detail && (flagged || set) ? { detail } : {}),
    };
  });
}

/**
 * `translate(effective, adapter, ctx)` of POLICY_ENGINE.md §4. Pure; never touches the network.
 */
export function translate(
  effective: EffectivePolicy,
  adapter: AdapterCapabilities,
  context: TranslationContext,
): EnforcementPlan {
  const degradation = context.degradation ?? 'fallback_ecloud_side';
  const b = new PlanBuilder(adapter, context);
  if (context.controls) b.controls.push(...context.controls);

  translateRates(b, effective, degradation);
  translateBurst(b, effective);
  const verifiedOctets = translateQuota(b, effective);
  const st = deriveSessionTimeout(context.clip, verifiedOctets, degradation);
  translateTimers(b, effective, st);
  translateInterim(b);
  translateVlan(b, effective);
  translateEcloudSideFields(b, effective);
  if (adapter.classAttr && context.sessionId)
    b.emit(adapter.classAttr, `ecloud:${context.sessionId}`, 'class');

  const sessionTimerEmitted = b.attrs.some(
    (a) => a.name === adapter.sessionTimeoutAttr && !a.experimental,
  );
  if (st.value !== null && (sessionTimerEmitted || degradation === 'fallback_ecloud_side')) {
    const now = context.now ?? new Date();
    b.controls.push({
      kind: 'session_timer',
      at: new Date(now.getTime() + st.value * 1000),
      params: { seconds: st.value, bound_by: st.boundBy, mirrors_radius: sessionTimerEmitted },
    });
  }

  const policyFieldFlags = b.unenforceable.filter(
    (u) =>
      (POLICY_FIELDS as readonly string[]).includes(u.field) && u.reason !== 'overflow_clamped',
  );
  const criticalHit = policyFieldFlags.filter((u) => effective.critical_fields.includes(u.field));
  let decision: 'accept' | 'reject' = 'accept';
  let reasonCode: string | null = null;
  if (criticalHit.length > 0) {
    decision = 'reject';
    reasonCode = `unenforceable:${[...new Set(criticalHit.map((u) => u.field))].sort().join(',')}`;
  } else if (degradation === 'strict_reject' && policyFieldFlags.length > 0) {
    decision = 'reject';
    reasonCode = `unenforceable:${[...new Set(policyFieldFlags.map((u) => u.field))].sort().join(',')}`;
  }

  return {
    adapter: adapter.key,
    adapterVersion: adapter.version,
    decision,
    reasonCode,
    radiusReplyAttributes: b.attrs,
    ecloudSideControls: b.controls,
    configPushChanges: b.config,
    unenforceable: b.unenforceable,
    fieldTable: buildFieldTable(b, effective),
    degradation,
    sessionTimeout: st,
  };
}
