/**
 * Agent settings: default permission mode + effort. Both drive the frozen
 * harness through its `/harness` slash commands (settings-store applies them);
 * the descriptions mirror what each level actually changes.
 */
import { SegmentedControl } from '@pi-desktop/ui';
import type { EffortLevel, PermissionMode } from '../../../electron/settings/settings-contract';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';

const PERMISSION_HINT: Record<PermissionMode, string> = {
  bypass: 'Run every tool call without review — fastest, least safe.',
  reviewer: 'A small model flags risky shell commands before they run.',
  'review-all': 'Approve every tool call yourself.',
};

const EFFORT_HINT: Record<EffortLevel, string> = {
  low: 'Fewest repair/review passes — fastest replies.',
  medium: 'Balanced repair + one self-review pass.',
  high: 'More repair attempts, extra review, adversarial checks.',
  max: 'Maximum reliability passes — slowest.',
};

export function AgentPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

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
    </SettingSection>
  );
}
