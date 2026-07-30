/**
 * The popup decision — the one piece of the window-open path worth pinning,
 * because it is the security-relevant half.
 *
 * A popup used to be DENIED outright and the opener navigated to its URL
 * instead. That broke every sign-in flow on the web: jedd signing into a site
 * with Google got a blank page after "Allow", because the consent screen had no
 * `window.opener` to post its result to and then called `window.close()` on a
 * window that was not a popup. The same flow completes in Safari and Chrome,
 * which open the real popup.
 *
 * Allowing popups is therefore right — but only for pages. A `window.open` on a
 * non-web scheme is a request to launch another application, coming from
 * untrusted web content.
 */
import { describe, expect, it } from 'vitest';
import { popupAllowed } from './browser-manager';

describe('which popups may open', () => {
  it('allows a real web page — this is the sign-in case', () => {
    expect(popupAllowed('https://accounts.google.com/o/oauth2/auth?client_id=x')).toBe(true);
    expect(popupAllowed('http://localhost:3000/callback')).toBe(true);
  });

  it('refuses a scheme that would launch another application', () => {
    for (const url of [
      'mailto:someone@example.com',
      'tel:+15551234',
      'itms-apps://apps.apple.com/app/id1',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(popupAllowed(url)).toBe(false);
    }
  });

  it('refuses anything that is not a URL at all', () => {
    for (const url of ['', '   ', 'not a url', 'about:blank?']) {
      expect(popupAllowed(url)).toBe(false);
    }
  });
});
