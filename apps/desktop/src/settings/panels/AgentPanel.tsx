/**
 * Agent settings: default permission mode + effort + the classifier preset. The
 * permission/effort segments drive the frozen harness through its `/harness`
 * slash commands (settings-store applies them); the preset picker sends
 * `/harness preset <x>` directly (pi-connect) and reflects the harness's live
 * active task class. The descriptions mirror what each level actually changes.
 */
import { SegmentedControl, Select, SelectContent, SelectItem, SelectTrigger } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import type { EffortLevel, PermissionMode } from '../../../electron/settings/settings-contract';
import { classLabel, useHarnessStatus } from '../../chat/harness-status';
import { applyHarnessPreset } from '../../state/pi-connect';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';

const PERMISSION_HINT: Record<PermissionMode, string> = {
  bypass: 'Run every tool call without review — fastest, least safe.',
  reviewer:
    'Flags risky shell commands before they run — regex rules, plus a small model when a local one is running.',
  'review-all': 'Approve every tool call yourself.',
};

const EFFORT_HINT: Record<EffortLevel, string> = {
  low: 'Fewest repair/review passes — fastest replies.',
  medium: 'Balanced repair + one self-review pass.',
  high: 'More repair attempts, extra review, adversarial checks.',
  max: 'Maximum reliability passes — slowest.',
};

/** Preset options: `auto` (classifier) + each task class. Mirrors the harness's
 * TASK_CLASSES (tiers then categories) — kept as a local list so the settings
 * panel doesn't pull the harness runtime into the renderer bundle. */
const PRESET_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto (classifier)' },
  { value: 'simple-QA', label: 'Simple Q&A' },
  { value: 'basic-tools', label: 'Basic tools' },
  { value: 'full-shebang', label: 'Full shebang' },
  { value: 'coding', label: 'Coding' },
  { value: 'file-ops', label: 'File ops' },
  { value: 'browser-use', label: 'Browser use' },
  { value: 'motion-graphics', label: 'Motion graphics' },
  { value: 'advanced-video', label: 'Advanced video' },
  { value: '3d', label: '3D' },
  { value: '2d-art', label: '2D art' },
  { value: 'other', label: 'Other' },
];

export function AgentPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  // The preset is owned by the harness session config (surfaced live via its
  // published status); reflect it here and drive it with a slash command.
  const harness = useHarnessStatus();
  const [preset, setPreset] = useState<string>('auto');
  useEffect(() => {
    if (harness?.preset !== undefined) setPreset(harness.preset);
  }, [harness?.preset]);

  const activeClass = classLabel(harness?.activeClass ?? null);
  const presetHint =
    preset === 'auto'
      ? activeClass !== null
        ? `The classifier picks a toolset per task. Currently active: ${activeClass}.`
        : 'The classifier picks the toolset per task automatically.'
      : 'Pin a fixed toolset for every task instead of auto-classifying.';

  const onPreset = (value: string) => {
    setPreset(value);
    void applyHarnessPreset(value);
  };

  return (
    <SettingSection
      title="Agent"
      description="How much oversight and effort the agent applies. Takes effect in the current session."
    >
      <SettingRow label="Permissions" hint={PERMISSION_HINT[settings.permissionMode]}>
        <SegmentedControl
          aria-label="Permission mode"
          data-testid="settings-permission"
          value={settings.permissionMode}
          onValueChange={(v) => void update({ permissionMode: v as PermissionMode })}
          options={[
            { value: 'bypass', label: 'Bypass' },
            { value: 'reviewer', label: 'Reviewer' },
            { value: 'review-all', label: 'Review all' },
          ]}
        />
      </SettingRow>

      <SettingRow label="Effort" hint={EFFORT_HINT[settings.effort]}>
        <SegmentedControl
          aria-label="Effort level"
          data-testid="settings-effort"
          value={settings.effort}
          onValueChange={(v) => void update({ effort: v as EffortLevel })}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
          ]}
        />
      </SettingRow>

      <SettingRow label="Task preset" hint={presetHint}>
        <Select value={preset} onValueChange={onPreset}>
          <SelectTrigger
            className="h-8 min-w-[170px]"
            aria-label="Task preset"
            data-testid="settings-preset"
          />
          <SelectContent>
            {PRESET_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </SettingSection>
  );
}
