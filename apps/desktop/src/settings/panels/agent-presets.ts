/**
 * The Agent settings "Task preset" dropdown options — kept in a pure module (no
 * React/UI imports) so they unit-test in the node env and stay a single source
 * of truth.
 *
 * Labels are typed `Record<TaskClass, string>` via a TYPE-ONLY harness import,
 * so the list CANNOT drift from the harness's task taxonomy: adding/removing a
 * class (or listing an invalid one — e.g. the retired `full-shebang`) is a
 * COMPILE error here, not a silent runtime mismatch.
 */
import type { TaskClass } from '@pi-desktop/harness';

/** Human label per task class. Insertion order = menu order (tiers, then categories). */
export const CLASS_LABELS: Record<TaskClass, string> = {
  'simple-QA': 'Simple Q&A',
  'basic-tools': 'Basic tools',
  coding: 'Coding',
  'file-ops': 'File ops',
  'browser-use': 'Browser use',
  'motion-graphics': 'Motion graphics',
  'advanced-video': 'Advanced video',
  '3d': '3D',
  '2d-art': '2D art',
  other: 'Other',
};

/** `auto` (classifier) + every task class, derived from {@link CLASS_LABELS}. */
export const PRESET_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto (classifier)' },
  ...Object.entries(CLASS_LABELS).map(([value, label]) => ({ value, label })),
];
