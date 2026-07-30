/**
 * Which browser tab the agent drives.
 *
 * jedd: with a page already open in the canvas browser, asking the model to look
 * at it opened a SECOND, blank "Pi Browser" tab and registered against that — so
 * `browser_snapshot` read about:blank and reported no interactive elements. "It
 * knows what tab I have open but the read call is reading the about blank???"
 * It did know; it was reading somewhere else.
 */
import { describe, expect, it } from 'vitest';
import { pickAgentBrowserTab } from './browser-agent';

const tab = (id: string, kind: string) => ({ id, kind });

describe('the tab the agent adopts', () => {
  it('takes the one the user is LOOKING at', () => {
    const tabs = [tab('t1', 'file'), tab('t2', 'browser'), tab('t3', 'browser')];
    expect(pickAgentBrowserTab(tabs, 't2')).toBe('t2');
  });

  it('falls back to the newest browser when the active tab is something else', () => {
    const tabs = [tab('t1', 'browser'), tab('t2', 'browser'), tab('t3', 'terminal')];
    expect(pickAgentBrowserTab(tabs, 't3')).toBe('t2');
  });

  it('opens its own only when NO browser is open — the one case it should', () => {
    expect(pickAgentBrowserTab([tab('t1', 'file')], 't1')).toBeUndefined();
    expect(pickAgentBrowserTab([], null)).toBeUndefined();
  });

  it('does not mistake a non-browser active tab for a browser', () => {
    // The bug in miniature: a situation-room tab active, a real page behind it.
    const tabs = [tab('page', 'browser'), tab('room', 'situation')];
    expect(pickAgentBrowserTab(tabs, 'room')).toBe('page');
  });
});
