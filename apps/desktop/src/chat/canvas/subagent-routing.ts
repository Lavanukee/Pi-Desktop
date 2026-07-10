/**
 * Renderer half of the subagent → canvas bridge. The harness (running inside pi)
 * streams the live subagent list over the extension `setStatus` channel under the
 * `harness-subagents` key (see @pi-desktop/harness). This hook reads that key,
 * maps it onto canvas `SubagentItem[]`, and opens/feeds a single live `subagent`
 * canvas tab — mirroring how `useBrowserAgent` / `useBashTerminalCanvasRouting`
 * open-once-then-quietly-refresh their live tabs.
 *
 * The tab is opened on the RISING edge of activity (a queued/running subagent
 * appears after none were active) so a fresh wave surfaces it, but it is not
 * force-reopened while the user has it closed mid-wave. Once open it updates in
 * place via `updateTab` so streaming step changes never steal focus.
 */
import type { CanvasController, SubagentItem } from '@pi-desktop/canvas';
import type { HarnessSubagentsStatus } from '@pi-desktop/harness';
import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../../state/canvas-store';
import { usePiStore } from '../../state/pi-slice';

/** Mirror of `HARNESS_SUBAGENTS_STATUS_KEY` in @pi-desktop/harness (kept local so
 * this stays a type-only dependency on the harness package). */
const SUBAGENTS_STATUS_KEY = 'harness-subagents';
/** Stable upsert key so the one subagent tab is reused, never duplicated. */
const SUBAGENT_TAB_KEY = 'pi:subagents';

/** Parse the published JSON, tolerating malformed/empty payloads. */
export function parseSubagentStatus(raw: string | undefined): HarnessSubagentsStatus | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as HarnessSubagentsStatus;
    return Array.isArray(parsed.subagents) ? parsed : null;
  } catch {
    return null;
  }
}

/** Map the harness wire items onto the canvas surface's `SubagentItem[]`. */
export function toSubagentItems(status: HarnessSubagentsStatus): SubagentItem[] {
  return status.subagents.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    ...(s.step !== undefined ? { step: s.step } : {}),
  }));
}

/**
 * Apply one status payload to the controller: open the subagent tab on the
 * RISING edge of activity, else quietly refresh it in place. Returns the new
 * active (queued/running) count for the caller to carry as `prevActive`. Pure of
 * React so it unit-tests against a real {@link CanvasController}.
 */
export function applySubagentStatus(
  controller: CanvasController,
  raw: string | undefined,
  prevActive: number,
  onOpen?: () => void,
): number {
  const status = parseSubagentStatus(raw);
  const items = status !== null ? toSubagentItems(status) : [];
  const activeNow = items.filter((i) => i.status === 'running' || i.status === 'queued').length;

  if (items.length === 0) return activeNow; // nothing to show yet (or cleared)

  const existing = controller.getState().tabs.find((t) => t.key === SUBAGENT_TAB_KEY);
  if (existing !== undefined) {
    controller.updateTab(existing.id, { subagents: items }); // quiet live refresh
    return activeNow;
  }
  // No tab yet: open it on the rising edge of activity (respect a user close
  // mid-wave — only reopen when a genuinely new wave of work begins).
  if (activeNow > 0 && prevActive === 0) {
    controller.upsertTab(SUBAGENT_TAB_KEY, {
      kind: 'subagent',
      title: 'Subagents',
      subagents: items,
    });
    onOpen?.();
  }
  return activeNow;
}

export function useSubagentCanvasRouting(controller: CanvasController): void {
  const raw = usePiStore((s) => s.extensionStatus[SUBAGENTS_STATUS_KEY]);
  // Count of active (queued/running) subagents at the previous tick — used to
  // detect the rising edge that opens the tab.
  const prevActive = useRef(0);

  useEffect(() => {
    prevActive.current = applySubagentStatus(controller, raw, prevActive.current, () =>
      // Ensure the rail is visible so the surface actually renders.
      useCanvasStore.getState().setCanvasOpen(true),
    );
  }, [raw, controller]);
}
