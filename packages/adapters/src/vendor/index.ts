/** Vendor-neutral adapter contract (MULTI_VENDOR_INTEGRATION_PLAN.md §6). */
export * from './types.js';
export {
  GENERIC_RADIUS_VENDOR_KEY,
  getVendorAdapter,
  listVendorAdapters,
  PORTAL_ORIGIN,
} from './first-party.js';
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
  decideWrapCorrection,
  DEFAULT_WRAP_MAX_BPS,
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
  type WrapCorrectionDecision,
  type WrapCorrectionInput,
} from './accounting.js';
export {
  LOGIN_TOKEN_CLOCK_SKEW_S,
  LOGIN_TOKEN_DEFAULT_TTL_S,
  LOGIN_TOKEN_MAX_TTL_S,
  LOGIN_TOKEN_PREFIX,
  LOGIN_TOKEN_PURPOSE,
  LoginTokenKey,
  checkLoginToken,
  consumeLoginToken,
  issueLoginToken,
  loginTokenUsedKey,
  type IssuedLoginToken,
  type LoginTokenBinding,
  type LoginTokenFailure,
  type LoginTokenResult,
  type SingleUseStore,
} from './login-token.js';
export * from './postback/index.js';
