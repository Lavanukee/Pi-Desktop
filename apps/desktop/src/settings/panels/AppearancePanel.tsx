/** Appearance settings: theme mode (light/dark/system), applied live and
 * persisted. The claude/codex flavor toggle moved to Interface → Advanced
 * (round-5 #23) so the main Appearance view stays to just light/dark/system. */
import { SegmentedControl } from '@pi-desktop/ui';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';

export function AppearancePanel() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  return (
    <SettingSection title="Appearance" description="Choose light, dark, or match your system.">
      <SettingRow label="Mode" hint="System follows your macOS appearance setting.">
        <SegmentedControl
          aria-label="Theme mode"
          data-testid="settings-mode"
          value={settings.theme.mode}
          onValueChange={(v) =>
            void update({
              theme: { mode: v === 'light' ? 'light' : v === 'dark' ? 'dark' : 'system' },
            })
          }
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'System' },
          ]}
        />
      </SettingRow>
    </SettingSection>
  );
}
