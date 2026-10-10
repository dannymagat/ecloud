/**
 * Message catalogue (Q77: English in release 1; layout is RTL-ready through `dir` + logical CSS
 * properties, so a locale is a catalogue entry, not a template change). Operator overrides for
 * the theme keys (`welcome_title`, …) come from `portal_themes.strings` via
 * `resolvePortalStrings` (@ecloud/shared); everything else is fixed product text.
 *
 * The error texts are deliberately generic: unknown NAS, bad signature, tenant mismatch, replay
 * and malformed redirects all show `error.generic` (no oracle, MULTI_VENDOR_INTEGRATION_PLAN.md
 * §6.2); a wrong password and an unknown username show the same `form.rejected`.
 */
export const DEFAULT_LOCALE = 'en';

const EN = {
  'title.landing': 'Wi-Fi sign-in',
  'title.login': 'Sign in',
  'title.voucher': 'Voucher',
  'title.terms': 'Terms of use',
  'title.success': 'Connected',
  'title.error': 'Sign-in unavailable',
  'title.expired': 'Page expired',
  'title.status': 'Connection status',
  'title.logout': 'Signed out',
  'title.handoff': 'Connecting',
  'landing.choose': 'Choose how to connect:',
  'landing.none': 'No sign-in method is available on this network.',
  'method.password': 'Sign in with username and password',
  'method.voucher': 'Use a voucher code',
  'method.click_through': 'Accept the terms and connect',
  'form.username': 'Username',
  'form.password': 'Password', // UI label. check-no-secrets: allow
  'form.voucher': 'Voucher code',
  'form.accept_terms': 'I accept the terms of use',
  'form.back': 'Back',
  'form.rejected': 'Sign-in failed. Check your details and try again.',
  'form.rate_limited': 'Too many attempts. Please wait {minutes} minute(s) and try again.',
  'form.csrf': 'Your sign-in page needs to be reloaded. Please try again.',
  'terms.none': 'By continuing you agree to use this network responsibly.',
  'terms.version': 'Version {version}',
  'success.continue': 'Continue to your page',
  'handoff.manual_text':
    'Your sign-in was accepted. Press Connect to finish connecting to the Wi-Fi network.',
  'handoff.submit': 'Connect',
  'success.status': 'View connection status',
  'error.generic':
    'We could not start sign-in on this network. Please reconnect to the Wi-Fi network and open any web page.',
  'error.failed': 'The network did not accept the sign-in.',
  'error.retry': 'Try again',
  'error.unavailable': 'The sign-in service is temporarily unavailable. Please try again shortly.',
  'error.not_found': 'Page not found.',
  'expired.flow':
    'This sign-in page has expired. Open any web page to start again from your Wi-Fi network.',
  'status.connected_since': 'Connected since',
  'status.data_used': 'Data used',
  'status.duration': 'Duration',
  'status.unknown': 'Connection details are not available yet.',
  'status.logout': 'Sign out',
  'logout.text': 'You have been signed out of the Wi-Fi network.',
  'skip.main': 'Skip to content',
  'handoff.text': 'Connecting you to the Wi-Fi network. If nothing happens, select Continue.',
  'handoff.button': 'Continue',
  'form.token': 'This sign-in page needs to be refreshed. Please try again.',
} as const;

export type MessageKey = keyof typeof EN;

const CATALOGUES: Readonly<Record<string, Readonly<Record<MessageKey, string>>>> = { en: EN };

/** Message for `key` in `locale` (falls back to English), with `{name}` placeholders filled. */
export function t(
  key: MessageKey,
  vars: Readonly<Record<string, string | number>> = {},
  locale: string = DEFAULT_LOCALE,
): string {
  const catalogue = CATALOGUES[locale] ?? EN;
  return catalogue[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export const MESSAGE_KEYS = Object.keys(EN) as MessageKey[];
