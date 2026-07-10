/**
 * Consume the harness's auto-generated conversation title and set it as the
 * active session's title (sidebar + top-bar).
 *
 * E1's classify+title piggyback publishes the title over the SAME status channel
 * as the plan/repair status — a dedicated `harness-title` key (`ctx.ui.setStatus`
 * → pi-slice `extensionStatus['harness-title']`). On a new conversation it
 * arrives on the first turn; we apply it so new chats get a real title instead
 * of "New chat", WITHOUT clobbering a title the user renamed by hand.
 *
 * The user-rename guard is `titleLocked` (set by `setSessionName`, reset on every
 * session change). The status key itself is cleared on session switch/new
 * (setMessagesExternal drops `harness*` keys), so a stale title never bleeds into
 * the next conversation.
 */
import { useEffect } from 'react';
import { applyHarnessTitle } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';

/**
 * Decide whether the harness title should be applied to the active session.
 * Pure so it unit-tests without React. Skips when: no title, blank, the user has
 * locked the title (renamed), or it already matches the current title.
 */
export function shouldApplyHarnessTitle(
  harnessTitle: string | undefined,
  windowTitle: string | null,
  titleLocked: boolean,
): boolean {
  if (harnessTitle === undefined) return false;
  const next = harnessTitle.trim();
  if (next.length === 0) return false;
  if (titleLocked) return false;
  if (windowTitle !== null && windowTitle.trim() === next) return false;
  return true;
}

/**
 * Wire the harness title → session title. Mount once (ChatApp). Reads the live
 * `harness-title` status and applies it when {@link shouldApplyHarnessTitle}
 * allows. Applying sets `windowTitle` to the same value, so the effect settles
 * after one apply (no loop).
 */
export function useHarnessTitleSync(): void {
  const harnessTitle = usePiStore((s) => s.extensionStatus['harness-title']);
  const windowTitle = usePiStore((s) => s.windowTitle);
  const titleLocked = usePiStore((s) => s.titleLocked);

  useEffect(() => {
    if (shouldApplyHarnessTitle(harnessTitle, windowTitle, titleLocked)) {
      void applyHarnessTitle((harnessTitle as string).trim());
    }
  }, [harnessTitle, windowTitle, titleLocked]);
}
