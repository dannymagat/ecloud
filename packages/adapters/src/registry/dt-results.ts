/**
 * Recorded real-device test results (PHASE2_VALIDATION.md §5.4). Only DT-01 has been executed
 * (D-034); it is identification only: it covers the row's identity facts (`identity:*`) and exactly
 * one capability cell, the negative "AP as WireGuard peer" finding (plan R-36).
 */
import type { DeviceTestResult } from './types.js';

/** Registry row DT-01 was recorded for (EZE-AP1832 / r32912, TIP uspot). */
const DT01_ROW_ID = 'ezelink-eze-ap1832-r32912-tip-uspot';

export const DT_RESULTS: readonly DeviceTestResult[] = Object.freeze([
  {
    id: 'DT-01',
    date: '2026-10-07',
    result: 'PASS',
    rowKey: DT01_ROW_ID,
    scope:
      'identification only: model, firmware, uCentral schema, uspot variant (TIP fork), installed packages (no wireguard/unetd, radius-gw-proxy present); no enforcement behaviour tested',
    evidenceFile:
      'test/fixtures/device/EZE-AP1832/r32912-6639b15f62/DT-01_identification_2026-10-07.txt',
    covers: ['identity:*', 'apWireguardPeer'],
  },
]);
