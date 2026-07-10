import { TASK_CLASSES } from '@pi-desktop/harness';
import { describe, expect, it } from 'vitest';
import { CLASS_LABELS, PRESET_OPTIONS } from './agent-presets';

describe('agent preset options', () => {
  it('no longer offers the retired "full-shebang" preset', () => {
    expect(PRESET_OPTIONS.map((o) => o.value)).not.toContain('full-shebang');
  });

  it('offers auto + exactly the harness task classes (no drift)', () => {
    const values = PRESET_OPTIONS.map((o) => o.value);
    expect(values[0]).toBe('auto');
    // The class options (everything after `auto`) must equal TASK_CLASSES exactly.
    expect(values.slice(1).sort()).toEqual([...TASK_CLASSES].sort());
  });

  it('labels every task class', () => {
    for (const cls of TASK_CLASSES) {
      expect(CLASS_LABELS[cls]).toBeTruthy();
    }
  });
});
