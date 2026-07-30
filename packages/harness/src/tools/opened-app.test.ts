/**
 * jedd: "whatever browser or app it opens something in via terminal (which is a
 * common issue I face) immediately give it the tools it needs and the initial
 * snapshot of whatever app or the browser snapshot of chrome."
 *
 * The failure is quiet: `open -a "Google Chrome" https://…` returns empty stdout
 * and exit 0, so the model either declares success without looking or falls back
 * to the BUILT-IN browser — a different browser, different logins, different page.
 */
import { describe, expect, it } from 'vitest';
import { detectOpenedApp, openedAppNote } from './opened-app';

describe('spotting that a command opened an app', () => {
  it('reads `open -a` with a quoted app and a URL', () => {
    const got = detectOpenedApp('open -a "Google Chrome" https://mail.google.com');
    expect(got?.app).toBe('Google Chrome');
    expect(got?.chrome).toBe(true);
    expect(got?.target).toBe('https://mail.google.com');
  });

  it('reads an unquoted app with no target', () => {
    const got = detectOpenedApp('open -a Safari');
    expect(got?.app).toBe('Safari');
    expect(got?.chrome).toBe(false);
    expect(got?.target).toBeUndefined();
  });

  it('handles a bare URL, where the SYSTEM picks the app', () => {
    const got = detectOpenedApp('open https://example.com');
    expect(got?.target).toBe('https://example.com');
    // We cannot name the app, and must not pretend to.
    expect(got?.app).toContain('default browser');
    expect(got?.chrome).toBe(false);
  });

  it('handles a file, and a command chained after a cd', () => {
    expect(detectOpenedApp('open ~/report.pdf')?.target).toBe('~/report.pdf');
    expect(detectOpenedApp('cd /tmp && open -a Preview shot.png')?.app).toBe('Preview');
  });

  it('recognises Chrome however it is spelled', () => {
    for (const name of ['Google Chrome', 'chrome', 'google chrome']) {
      expect(detectOpenedApp(`open -a "${name}"`)?.chrome).toBe(true);
    }
  });

  it('ignores commands that did not open an app', () => {
    for (const cmd of ['ls -la', 'python3 open.py', 'grep open file.txt', 'open', 'open .']) {
      expect(detectOpenedApp(cmd)).toBeUndefined();
    }
  });
});

describe('what the model is told afterwards', () => {
  it('sends Chrome down the DOM path, and warns off the built-in browser', () => {
    const note = openedAppNote({ app: 'Google Chrome', chrome: true, target: 'https://x.test' });
    expect(note).toContain('chrome_snapshot');
    expect(note).toContain('different browser');
    expect(note).not.toContain('mac_snapshot');
    // Routed through `use`, which is always advertised — so the next action can
    // actually happen instead of naming a tool the model cannot reach.
    expect(note).toContain('use with tool=');
  });

  it('sends everything else to computer use, and says a screenshot is automatic', () => {
    const note = openedAppNote({ app: 'Preview', chrome: false, target: 'shot.png' });
    expect(note).toContain('mac_snapshot');
    expect(note).toContain('use with tool=');
    expect(note).toContain('act by x,y coordinates');
  });

  it('names what was opened, so the model is not guessing', () => {
    expect(openedAppNote({ app: 'Safari', chrome: false })).toContain('Safari');
  });
});

describe('a web page opened from the shell with no browser named', () => {
  // jedd: "bias it to use the built in browser instead of bash to open safari
  // when no specific is requested."
  it('is redirected to browser_navigate, which it can actually drive', () => {
    const opened = detectOpenedApp('open https://example.com');
    if (opened === undefined) throw new Error('not detected');
    expect(opened.strayWebPage).toBe(true);
    const note = openedAppNote(opened);
    expect(note).toContain('browser_navigate("https://example.com")');
    expect(note).toContain('cannot drive');
  });

  it('does NOT redirect when the user named a browser — that was deliberate', () => {
    const opened = detectOpenedApp('open -a Safari https://example.com');
    if (opened === undefined) throw new Error('not detected');
    expect(opened.strayWebPage).toBeUndefined();
    expect(openedAppNote(opened)).toContain('mac_snapshot');
  });

  it('leaves a FILE open alone — that is not a web page', () => {
    const opened = detectOpenedApp('open ~/report.pdf');
    if (opened === undefined) throw new Error('not detected');
    expect(opened.strayWebPage).toBeUndefined();
  });
});
