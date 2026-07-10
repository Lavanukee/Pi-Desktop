import { describe, expect, it } from 'vitest';
import { usePiStore } from '../state/pi-slice';
import { shouldApplyHarnessTitle } from './harness-title';

describe('shouldApplyHarnessTitle', () => {
  it('applies a fresh harness title when nothing is set and not locked', () => {
    expect(shouldApplyHarnessTitle('Sandboxels physics sim', null, false)).toBe(true);
  });

  it('does NOT clobber a user-renamed (locked) title', () => {
    expect(shouldApplyHarnessTitle('Auto title', 'My chat', true)).toBe(false);
  });

  it('skips when the title already matches (no redundant apply / no loop)', () => {
    expect(shouldApplyHarnessTitle('Same title', 'Same title', false)).toBe(false);
    expect(shouldApplyHarnessTitle('  Same title  ', 'Same title', false)).toBe(false);
  });

  it('skips absent / blank titles', () => {
    expect(shouldApplyHarnessTitle(undefined, null, false)).toBe(false);
    expect(shouldApplyHarnessTitle('   ', null, false)).toBe(false);
  });

  it('replaces a different, unlocked existing title', () => {
    expect(shouldApplyHarnessTitle('Better title', 'Chat', false)).toBe(true);
  });
});

describe('title-lock reset on session change', () => {
  it('clears the user-rename lock when the session is switched/new', () => {
    // Simulate a user rename lock.
    usePiStore.setState({ titleLocked: true, windowTitle: 'User named' });
    expect(usePiStore.getState().titleLocked).toBe(true);

    // A session switch/new goes through setMessagesExternal, which must reset it
    // so the fresh conversation is eligible for auto-titling again.
    usePiStore.getState().setMessagesExternal([]);
    expect(usePiStore.getState().titleLocked).toBe(false);
  });

  it('drops the stale harness-title status on session change', () => {
    usePiStore.getState().setMessagesExternal([]);
    usePiStore.setState((s) => ({
      extensionStatus: { ...s.extensionStatus, 'harness-title': 'Old chat title' },
    }));
    usePiStore.getState().setMessagesExternal([]);
    expect(usePiStore.getState().extensionStatus['harness-title']).toBeUndefined();
  });
});
