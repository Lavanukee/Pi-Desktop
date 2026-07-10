/**
 * Unit coverage for the subagent → canvas router: JSON parse/map + the pure
 * controller-driving `applySubagentStatus` (open-once on the rising edge, quiet
 * refresh thereafter, respect a user close). No React / IPC here — driven by a
 * real CanvasController.
 */
import { CanvasController } from '@pi-desktop/canvas';
import type { HarnessSubagentsStatus } from '@pi-desktop/harness';
import { describe, expect, it, vi } from 'vitest';
import { applySubagentStatus, parseSubagentStatus, toSubagentItems } from './subagent-routing';

const status = (subagents: HarnessSubagentsStatus['subagents']): string =>
  JSON.stringify({ subagents } satisfies HarnessSubagentsStatus);

describe('parseSubagentStatus', () => {
  it('parses a well-formed payload', () => {
    const parsed = parseSubagentStatus(status([{ id: 'a', name: 'A', status: 'running' }]));
    expect(parsed?.subagents).toHaveLength(1);
  });
  it('returns null for empty / malformed / non-array payloads', () => {
    expect(parseSubagentStatus(undefined)).toBeNull();
    expect(parseSubagentStatus('')).toBeNull();
    expect(parseSubagentStatus('{not json')).toBeNull();
    expect(parseSubagentStatus('{"subagents":"nope"}')).toBeNull();
  });
});

describe('toSubagentItems', () => {
  it('maps the harness items onto canvas SubagentItem[], preserving step', () => {
    const items = toSubagentItems({
      subagents: [
        { id: 'a', name: 'A', step: 'Reading…', status: 'running' },
        { id: 'b', name: 'B', status: 'done' },
      ],
    });
    expect(items).toEqual([
      { id: 'a', name: 'A', status: 'running', step: 'Reading…' },
      { id: 'b', name: 'B', status: 'done' },
    ]);
  });
});

describe('applySubagentStatus', () => {
  it('opens a subagent tab on the rising edge and calls onOpen', () => {
    const c = new CanvasController();
    const onOpen = vi.fn();
    const active = applySubagentStatus(
      c,
      status([{ id: 'w1', name: 'Research', step: 'Working…', status: 'running' }]),
      0,
      onOpen,
    );
    expect(active).toBe(1);
    expect(onOpen).toHaveBeenCalledOnce();
    const tab = c.getState().tabs.find((t) => t.key === 'pi:subagents');
    expect(tab?.kind).toBe('subagent');
    expect(tab?.subagents).toEqual([
      { id: 'w1', name: 'Research', status: 'running', step: 'Working…' },
    ]);
  });

  it('quietly refreshes the existing tab without stealing focus', () => {
    const c = new CanvasController();
    applySubagentStatus(c, status([{ id: 'w1', name: 'Research', status: 'running' }]), 0);
    // Open another tab and focus it — a live refresh must not change the active tab.
    const otherId = c.openTab({ kind: 'terminal', title: 'Terminal' });
    expect(c.getState().activeTabId).toBe(otherId);

    const onOpen = vi.fn();
    applySubagentStatus(
      c,
      status([{ id: 'w1', name: 'Research', step: 'Summarizing…', status: 'running' }]),
      1,
      onOpen,
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(c.getState().activeTabId).toBe(otherId); // focus unchanged
    const tab = c.getState().tabs.find((t) => t.key === 'pi:subagents');
    expect(tab?.subagents?.[0]?.step).toBe('Summarizing…');
  });

  it('does not reopen a tab the user closed while work is still ongoing', () => {
    const c = new CanvasController();
    applySubagentStatus(c, status([{ id: 'w1', name: 'A', status: 'running' }]), 0);
    const tab = c.getState().tabs.find((t) => t.key === 'pi:subagents');
    c.closeTab(tab?.id ?? '');
    const onOpen = vi.fn();
    // Still active (prevActive=1) → not a rising edge → stays closed.
    applySubagentStatus(c, status([{ id: 'w1', name: 'A', status: 'running' }]), 1, onOpen);
    expect(c.getState().tabs.some((t) => t.key === 'pi:subagents')).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not open for a done-only payload (no active work)', () => {
    const c = new CanvasController();
    const active = applySubagentStatus(c, status([{ id: 'w1', name: 'A', status: 'done' }]), 0);
    expect(active).toBe(0);
    expect(c.getState().tabs).toHaveLength(0);
  });
});
