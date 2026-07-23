/**
 * UI customization (round-5 #23). The main section keeps the everyday chrome
 * knob (global icon stroke width → `--pd-icon-stroke` on the document root,
 * persisted as `iconStroke`). An ADVANCED section below holds the nitpicky
 * customization: the claude/codex theme FLAVOR toggle (relocated out of the main
 * Appearance view) and a developer entry into the component GALLERY (relocated
 * off the top bar). Default icon stroke is the token value (1.25).
 */
import { Button, IconStrokeControl, SegmentedControl, Slider } from '@pi-desktop/ui';
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
  const sidebarScale = useSettingsStore((s) => s.settings.sidebarScale);
  const menuScale = useSettingsStore((s) => s.settings.menuScale);
  const flavor = useSettingsStore((s) => s.settings.theme.flavor);
  const productionHarness = useSettingsStore((s) => s.settings.experimentalProductionHarness);
  const generation = useSettingsStore((s) => s.settings.experimentalGeneration);
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

      <SettingSection
        title="Element size"
        description="Scale individual parts of the app up or down. 1.00× is the default."
      >
        <SettingRow label="Sidebar size" hint="Scale the sidebar's rows, icons and text.">
          <div className="flex items-center gap-3">
            <Slider
              min={0.8}
              max={1.5}
              step={0.05}
              value={sidebarScale}
              aria-label="Sidebar size"
              data-testid="settings-sidebar-scale"
              onValueChange={(v) => void update({ sidebarScale: v })}
            />
            <span className="text-caption font-mono text-text-secondary tabular-nums">
              {sidebarScale.toFixed(2)}×
            </span>
            {sidebarScale !== 1 ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="settings-sidebar-scale-reset"
                onClick={() => void update({ sidebarScale: 1 })}
              >
                Reset
              </Button>
            ) : null}
          </div>
        </SettingRow>

        <SettingRow
          label="Menu size"
          hint="Scale dropdown menu options (the model picker and the + menu)."
        >
          <div className="flex items-center gap-3">
            <Slider
              min={0.8}
              max={1.5}
              step={0.05}
              value={menuScale}
              aria-label="Menu size"
              data-testid="settings-menu-scale"
              onValueChange={(v) => void update({ menuScale: v })}
            />
            <span className="text-caption font-mono text-text-secondary tabular-nums">
              {menuScale.toFixed(2)}×
            </span>
            {menuScale !== 1 ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="settings-menu-scale-reset"
                onClick={() => void update({ menuScale: 1 })}
              >
                Reset
              </Button>
            ) : null}
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection title="Advanced" description="Deeper customization and developer tools.">
        <SettingRow
          label="Theme flavor"
          hint="Bobble is the native look; Claude and Codex match those apps."
        >
          <SegmentedControl
            aria-label="Theme flavor"
            data-testid="settings-flavor"
            value={flavor}
            onValueChange={(v) =>
              void update({
                theme: { flavor: v === 'codex' ? 'codex' : v === 'claude' ? 'claude' : 'bobble' },
              })
            }
            options={[
              { value: 'bobble', label: 'Bobble' },
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

      <SettingSection
        title="Experimental"
        description="Early features that are still being built. May be rough — off by default."
      >
        <SettingRow
          label="Coordination harness"
          hint="Route a prompt through the multi-agent coordination harness and watch it work in the situation room, instead of a normal single-agent chat. Experimental."
        >
          <SegmentedControl
            aria-label="Coordination harness"
            data-testid="settings-production-harness"
            value={productionHarness ? 'on' : 'off'}
            onValueChange={(v) => void update({ experimentalProductionHarness: v === 'on' })}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="On-device generation"
          hint="Give the assistant on-device image/video generation tools (Apple-Silicon MLX/mflux; ComfyUI for video) that stream results onto the canvas. Downloads models on first use. Restart to apply. Experimental."
        >
          <SegmentedControl
            aria-label="On-device generation"
            data-testid="settings-experimental-generation"
            value={generation ? 'on' : 'off'}
            onValueChange={(v) => void update({ experimentalGeneration: v === 'on' })}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
            ]}
          />
        </SettingRow>
      </SettingSection>
    </div>
  );
}
