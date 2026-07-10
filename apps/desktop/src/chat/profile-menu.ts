/**
 * Pure data for the bottom-left profile dropup (round-12 #4): the single
 * sidebar-footer button opens a dropup with, top→bottom, a Settings action, a
 * Toggle-theme action, a divider, and — pinned to the bottom — the User /
 * Power-user segmented toggle. Kept UI-free so the structure (labels, testids,
 * copy) is unit-testable in the node test env; SessionSidebar renders from it.
 */
import type { UserMode } from '../../electron/settings/settings-contract';

/** The two action rows above the divider, in render (top→bottom) order. */
export type ProfileMenuActionId = 'settings' | 'theme';

export interface ProfileMenuAction {
  id: ProfileMenuActionId;
  label: string;
  /** Kept stable so the existing e2e probes still reach these controls. */
  testid: string;
}

export const PROFILE_MENU_ACTIONS: readonly ProfileMenuAction[] = [
  { id: 'settings', label: 'Settings', testid: 'open-settings' },
  { id: 'theme', label: 'Toggle theme', testid: 'toggle-mode' },
];

export interface UserModeOption {
  value: UserMode;
  /** Segment label (the mode name). */
  label: string;
  /** One-word-ish explanation of the mode, shown under the segmented control. */
  blurb: string;
  testid: string;
}

/** The bottom User / Power-user toggle options, in segmented (left→right) order. */
export const USER_MODE_OPTIONS: readonly UserModeOption[] = [
  { value: 'user', label: 'User', blurb: 'Simple — automatic model', testid: 'usermode-user' },
  { value: 'power', label: 'Power user', blurb: 'Full model control', testid: 'usermode-power' },
];

/** The blurb for the active mode (drives the descriptor line under the toggle). */
export function userModeBlurb(mode: UserMode): string {
  return USER_MODE_OPTIONS.find((o) => o.value === mode)?.blurb ?? '';
}
