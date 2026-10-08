/**
 * Device measurement harness types (Phase 7 P7-B AC1): DT-04 / DT-05 / DT-06 of
 * PHASE2_VALIDATION.md §5.2 as scripts. The harness measures and PROPOSES a verdict; it never
 * records PASS — a human signs the PHASE2_VALIDATION.md §5.4 row after reviewing the evidence.
 */

export const PROFILE_FORMAT = 'ecloud-device-profile/v1';
export const RESULT_FORMAT = 'ecloud-device-measurement/v1';
export const HARNESS_VERSION = '0.1.0';

export type DtId = 'DT-04' | 'DT-05' | 'DT-06';
export const DT_IDS: readonly DtId[] = ['DT-04', 'DT-05', 'DT-06'];

export type Direction = 'down' | 'up';

/** What the lab looked like (results template §5.4 columns; no secrets, ever). */
export interface LabDescription {
  readonly tester: string;
  readonly ezeap_model: string;
  readonly firmware: string;
  readonly schema_version: string;
  readonly uspot_variant: string;
  readonly nas_path: 'uam' | 'dot1x' | 'mac' | 'chilli';
}

export interface Iperf3Settings {
  readonly server: string;
  readonly port: number;
  /** Seconds per throughput run (DT-04 uses 20 s). */
  readonly duration_s: number;
  /** TCP slow-start seconds to omit from the samples (`-O`). */
  readonly omit_s: number;
}

/** DT-04: per-client rate from RADIUS (WISPr / ChilliSpot) measured both ways. */
export interface ThroughputCase {
  readonly id: string;
  readonly description: string;
  /** null = direction not limited in this case (not measured). */
  readonly expected_down_kbps: number | null;
  readonly expected_up_kbps: number | null;
  /** AAA T-A10 / DT-04: ±10 %. */
  readonly tolerance_pct: number;
}

/** DT-05 (a): Session-Timeout — continuous traffic until the NAS cuts the session. */
export interface SessionTimeoutCase {
  readonly id: string;
  readonly kind: 'session_timeout';
  readonly description: string;
  readonly expected_s: number;
  readonly tolerance_s: number;
  /** Upper bound of the iperf3 run (> expected_s). */
  readonly max_duration_s: number;
}

/** DT-05 (a): Idle-Timeout — stay idle, then one short probe; expect (un)reachable. */
export interface IdleProbeCase {
  readonly id: string;
  readonly kind: 'idle_probe';
  readonly description: string;
  readonly idle_timeout_s: number;
  readonly idle_wait_s: number;
  /** true when idle_wait_s < idle_timeout_s (session must survive), false otherwise. */
  readonly expect_reachable: boolean;
  readonly probe_s: number;
}

export type TimerCase = SessionTimeoutCase | IdleProbeCase;

/** DT-06: ChilliSpot-Max-Total-Octets cut-off. */
export interface QuotaCase {
  readonly id: string;
  readonly description: string;
  readonly quota_bytes: number;
  readonly direction: Direction;
  readonly duration_s: number;
  /** uspot (TIP) polls counters every 10 s: allowed overshoot = poll × rate. */
  readonly poll_interval_s: number;
  /** iperf3 counts TCP payload; RADIUS counts IP bytes: an early cut within this % is expected. */
  readonly early_tolerance_pct: number;
}

export interface DeviceProfile {
  readonly format: typeof PROFILE_FORMAT;
  readonly lab: LabDescription;
  readonly iperf3: Iperf3Settings;
  readonly cases: {
    readonly 'DT-04'?: readonly ThroughputCase[];
    readonly 'DT-05'?: readonly TimerCase[];
    readonly 'DT-06'?: readonly QuotaCase[];
  };
}

export interface Sample {
  readonly start_s: number;
  readonly end_s: number;
  readonly bytes: number;
  readonly bits_per_second: number;
}

export interface Iperf3Run {
  readonly direction: Direction;
  readonly argv: readonly string[];
  readonly exit_code: number | null;
  /** iperf3 `error` (connection refused, control socket closed, …) or a harness error. */
  readonly error: string | null;
  /** Non-omitted 1 s intervals. */
  readonly samples: readonly Sample[];
  /** Receiver-side average (`end.sum_received`), the figure DT-04 compares. */
  readonly receiver_bits_per_second: number | null;
  readonly sender_bits_per_second: number | null;
}

/** The harness may only PROPOSE; `PASS` is a human decision (results template §5.4). */
export type ProposedVerdict = 'PROPOSED_PASS' | 'PROPOSED_FAIL' | 'INCONCLUSIVE';

export interface Finding {
  readonly check: string;
  readonly expected: string;
  readonly measured: string;
  readonly proposed: ProposedVerdict;
  readonly note: string;
}

export interface MeasurementResult {
  readonly format: typeof RESULT_FORMAT;
  readonly harness_version: string;
  readonly dt: DtId;
  readonly case_id: string;
  readonly mode: 'dry-run' | 'live';
  /** Dry-run output (fake iperf3) is never evidence. */
  readonly evidence_usable: boolean;
  readonly started_at: string;
  readonly finished_at: string;
  readonly lab: LabDescription;
  readonly expectation: unknown;
  readonly tool: { readonly command: readonly string[] };
  readonly runs: readonly Iperf3Run[];
  readonly findings: readonly Finding[];
  readonly proposed_verdict: ProposedVerdict;
  /** Always pending: the harness refuses to mark PASS (P7-B AC1). */
  readonly verdict: 'PENDING_HUMAN_SIGNOFF';
  readonly signoff: {
    readonly required: true;
    readonly signed_by: null;
    readonly signed_at: null;
    readonly final_result: null;
    readonly instructions: string;
  };
  /** Values the operator reads from pcap / AP and adds before sign-off. */
  readonly manual_observations: Readonly<Record<string, null>>;
  readonly results_row_draft: string;
}
