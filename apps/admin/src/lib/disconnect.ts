/**
 * Session Disconnect gating (ADMIN_UI_ARCHITECTURE.md §3, D-028, D-006): the button is enabled
 * only when the NAS adapter's disconnect capability is device-enforced — VERIFIED_SUPPORTED with
 * LAB_VALIDATED/PRODUCTION_VALIDATED evidence and a device-test reference (plan rules V5, V12) —
 * the operator holds `session:disconnect`, and the API exposes a disconnect endpoint. Today no
 * adapter qualifies, so the button is always disabled with the reason as its tooltip.
 */
import { presentStatus } from './adapterStatus';

export interface DisconnectGateInput {
  /** Adapter disconnect status, or undefined when unknown to this operator. */
  status: unknown;
  /** Evidence level of the disconnect capability (absent ⇒ not device-enforced). */
  evidenceLevel?: unknown;
  dtRefs?: readonly string[];
  adapterKey: string | null;
  hasPermission: boolean;
  endpointAvailable: boolean;
}

export interface DisconnectGate {
  enabled: boolean;
  reason: string;
}

export function disconnectGate(input: DisconnectGateInput): DisconnectGate {
  if (!input.hasPermission)
    return { enabled: false, reason: 'Requires the session:disconnect permission.' };
  if (input.status === undefined || input.status === null) {
    return {
      enabled: false,
      reason: `Disconnect status of adapter ${input.adapterKey ?? '(unknown)'} is unknown; disconnect is only offered when it is VERIFIED_SUPPORTED.`,
    };
  }
  const p = presentStatus(input.status, input.evidenceLevel, { dtRefs: input.dtRefs });
  if (!p.deviceEnforced) {
    return {
      enabled: false,
      reason: `Adapter ${input.adapterKey ?? '(unknown)'} disconnect is ${p.status} (${p.evidenceLevel ?? 'no evidence level'}): not validated on a lab device, so ECLOUD does not offer it.`,
    };
  }
  if (!input.endpointAvailable) {
    return { enabled: false, reason: 'The connected API has no session disconnect endpoint yet.' };
  }
  return { enabled: true, reason: 'Send a RADIUS Disconnect-Request to the NAS.' };
}
