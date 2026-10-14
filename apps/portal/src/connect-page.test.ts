/**
 * The connect page: what a click-through portal with no terms document renders.
 *
 * This is the page the migration-041 platform-default portal serves, and the owner's request was
 * "connect button only". Two behaviours are asserted because each removes a tap that asks the
 * guest a question with one answer: no acceptance checkbox when there is no document to accept,
 * and no back link when the portal offers a single method.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, renderPage, type PageBody } from './pages.js';

function render(body: PageBody): string {
  return renderPage(DEFAULT_THEME, { portalName: 'Guest', siteName: 'Site' }, body, {
    mode: 'inline',
  });
}

const form = { action: '/f/t/click', csrf: 'c' };

describe('connect page without a terms document', () => {
  it('renders one submit button, a hidden acceptance and no checkbox', () => {
    const html = render({
      page: 'terms',
      form,
      error: null,
      termsText: null,
      termsVersion: null,
      backHref: null,
    });
    expect(html).toContain('<input type="hidden" name="accept_terms" value="yes">');
    expect(html).not.toContain('type="checkbox"');
    // The acceptance sentence still appears: continuing is the acceptance.
    expect(html).toContain('use this network responsibly');
    expect(html.match(/<button type="submit">/g)).toHaveLength(1);
    // Nothing to go back to on a single-method portal.
    expect(html).not.toContain('>Back<');
  });

  it('still requires a ticked checkbox when a terms document is configured', () => {
    const html = render({
      page: 'terms',
      form,
      error: null,
      termsText: 'The actual terms.',
      termsVersion: '3',
      backHref: '/f/t',
    });
    // A specific document to accept means acceptance must be a separate, deliberate act.
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="accept_terms"');
    expect(html).toContain('required');
    expect(html).toContain('The actual terms.');
    expect(html).toContain('Version 3');
    expect(html).not.toContain('<input type="hidden" name="accept_terms"');
  });

  it('escapes an operator-supplied terms document', () => {
    const html = render({
      page: 'terms',
      form,
      error: null,
      termsText: '<script>alert(1)</script>',
      termsVersion: null,
      backHref: null,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
