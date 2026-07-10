/**
 * UI customization (round-5 #23). The main section keeps the everyday chrome
 * knob (global icon stroke width → `--pd-icon-stroke` on the document root,
 * persisted as `iconStroke`). An ADVANCED section below holds the nitpicky
 * customization: the claude/codex theme FLAVOR toggle (relocated out of the main
 * Appearance view) and a developer entry into the component GALLERY (relocated
 * off the top bar). Default icon stroke is the token value (1.25).
 */
import { Button, IconStrokeControl, SegmentedControl } from '@pi-desktop/ui';
import { useSettingsStore } from '../../state/settings-store';
import { SettingRow, SettingSection } from '../parts';

export function InterfacePanel({
  onOpenGallery,
  onRedoOnboarding,
}: {
  onOpenGallery?: () => void;
  onRedoOnboarding?: () => void;
}) {
  const iconStroke = useSettingsStore((s) => s.settings.iconStroke);
  const flavor = useSettingsStore((s) => s.settings.theme.flavor);
  const update = useSettingsStore((s) => s.update);

  return (
    <div className="flex flex-col gap-8">
      <SettingSection title="Interface" description="Fine-tune how the app's chrome looks.">
        <SettingRow
          label="Icon thickness"
          hint="How heavy the line icons throughout the app appear. Lighter reads calmer."
        >
          <IconStrokeControl
            data-testid="settings-icon-stroke"
            value={iconStroke}
            onChange={(v) => void update({ iconStroke: v })}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title="Advanced" description="Deeper customization and developer tools.">
        <SettingRow label="Theme flavor" hint="Match the app's look to Claude or Codex.">
          <SegmentedControl
            aria-label="Theme flavor"
            data-testid="settings-flavor"
            value={flavor}
            onValueChange={(v) =>
              void update({ theme: { flavor: v === 'codex' ? 'codex' : 'claude' } })
            }
            options={[
              { value: 'claude', label: 'Claude' },
              { value: 'codex', label: 'Codex' },
            ]}
          />
        </SettingRow>

        {onRedoOnboarding !== undefined ? (
          <SettingRow
            label="Redo onboarding"
            hint="Replay the first-run setup wizard (imports, theme, experience). Your settings are kept."
          >
            <div>
              <Button
                variant="outline"
                size="sm"
                data-testid="settings-redo-onboarding"
                onClick={onRedoOnboarding}
              >
                Redo onboarding
              </Button>
            </div>
          </SettingRow>
        ) : null}

        {onOpenGallery !== undefined ? (
          <SettingRow
            label="Component gallery (dev)"
            hint="Browse the design-system component spec book."
          >
            <div>
              <Button
                variant="outline"
                size="sm"
                data-testid="settings-open-gallery"
                onClick={onOpenGallery}
              >
                Open component gallery
              </Button>
            </div>
          </SettingRow>
        ) : null}
      </SettingSection>
    </div>
  );
}
