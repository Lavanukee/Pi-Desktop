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
import { popupAllowed, stripEmbedderTokens } from './browser-manager';

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

describe('what the browser calls itself', () => {
  /*
   * Google's sign-in refuses embedded user agents by policy, and Electron's
   * default advertises both the app and the framework. jedd's Google sign-in
   * white-screens on accounts.google.com/gsi/* while the same flow completes in
   * Safari and Chrome — that string is why.
   */
  it('strips the app and framework tokens, keeping the real Chromium', () => {
    const raw =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Bobble/0.1.0 Chrome/140.0.0.0 Electron/43.1.0 Safari/537.36';
    const cleaned = stripEmbedderTokens(raw);
    expect(cleaned).not.toContain('Electron/');
    expect(cleaned).not.toContain('Bobble/');
    // What remains is a truthful description of the engine actually rendering.
    expect(cleaned).toContain('Chrome/140.0.0.0');
    expect(cleaned).toContain('AppleWebKit/537.36');
    expect(cleaned).toContain('Safari/537.36');
  });

  it('leaves an already-clean agent alone', () => {
    const clean =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/140.0.0.0 Safari/537.36';
    expect(stripEmbedderTokens(clean)).toBe(clean);
  });
});
