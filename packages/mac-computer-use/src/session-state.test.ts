import { describe, expect, it } from 'vitest';
import { createMacSessionState } from './session-state.js';

describe('createMacSessionState (controlled-app state machine)', () => {
  it('starts with no control: empty target params, empty description', () => {
    const s = createMacSessionState();
    expect(s.controlled()).toBeNull();
    expect(s.targetParams()).toEqual({});
    expect(s.describe()).toBe('');
  });

  it('a launch takes control and stamps the pid onto every act', () => {
    const s = createMacSessionState();
    s.noteLaunched('TextEdit', 4242, 99);
    expect(s.controlled()).toEqual({ pid: 4242, app: 'TextEdit', windowId: 99 });
    expect(s.targetParams()).toEqual({ pid: 4242 });
    expect(s.describe()).toContain('"TextEdit"');
    expect(s.describe()).toContain('4242');
  });

  it('a snapshot of a different app MOVES control to it', () => {
    const s = createMacSessionState();
    s.noteLaunched('TextEdit', 4242);
    s.noteSnapshot({ app: 'Maps', pid: 7777, windowId: 12 });
    expect(s.controlled()).toEqual({ pid: 7777, app: 'Maps', windowId: 12 });
    expect(s.targetParams()).toEqual({ pid: 7777 });
  });

  it('a same-pid snapshot refreshes without losing the known windowId', () => {
    const s = createMacSessionState();
    s.noteLaunched('TextEdit', 4242, 99);
    s.noteSnapshot({ app: 'TextEdit', pid: 4242 }); // no windowId on the wire
    expect(s.controlled()).toEqual({ pid: 4242, app: 'TextEdit', windowId: 99 });
  });

  it('an unresolved snapshot (no pid) cannot take or clobber control', () => {
    const s = createMacSessionState();
    s.noteSnapshot({ app: 'Mystery' });
    expect(s.controlled()).toBeNull();
    s.noteLaunched('TextEdit', 4242);
    s.noteSnapshot({});
    expect(s.controlled()?.pid).toBe(4242);
  });

  it('release drops control back to the pre-launch state', () => {
    const s = createMacSessionState();
    s.noteLaunched('TextEdit', 4242);
    s.release();
    expect(s.controlled()).toBeNull();
    expect(s.targetParams()).toEqual({});
    expect(s.describe()).toBe('');
  });
});
