/** Vendor-neutral adapter contract (MULTI_VENDOR_INTEGRATION_PLAN.md §6). */
export * from './types.js';
export { getVendorAdapter, listVendorAdapters, PORTAL_ORIGIN } from './first-party.js';
export {
  computeUamSignature,
  encodeUamPapPassword,
  isPrivateIpv4,
  safeUserUrl,
  splitUamQuery,
  verifyUamSignature,
  type UamQuery,
} from './uam.js';
export {
  EVENT_TIME_TOLERANCE_MS,
  counterDelta,
  counterWrap32Quirks,
  deriveTimes,
  mapStatusType,
  maxCounters,
  normalizeAccounting,
  normalizeMacAddress,
  normalizeTerminateCause,
  parseClassSessionId,
  type AccountingStatusType,
  type RadiusAcctStatusType,
  type SessionCounters,
} from './accounting.js';
