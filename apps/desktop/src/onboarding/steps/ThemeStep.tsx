/**
 * Step 3 — auto-theme. Flavor + mode were preset from the source app; both are
 * swappable here and apply live to the whole app (the theme store drives the
 * data-flavor/data-mode attributes on <html>).
 */
import { SegmentedControl } from '@pi-desktop/ui';
import { useThemeStore } from '../../store/theme';

export function ThemeStep() {
  const flavor = useThemeStore((s) => s.flavor);
  const mode = useThemeStore((s) => s.mode);
  const setFlavor = useThemeStore((s) => s.setFlavor);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-footnote text-text-muted">Appearance</span>
        <SegmentedControl
          aria-label="Theme flavor"
          value={flavor}
          onValueChange={(v) =>
            setFlavor(v === 'codex' ? 'codex' : v === 'claude' ? 'claude' : 'bobble')
          }
          options={[
            { value: 'bobble', label: 'Bobble' },
            { value: 'claude', label: 'Claude' },
            { value: 'codex', label: 'Codex' },
          ]}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-footnote text-text-muted">Mode</span>
        <SegmentedControl
          aria-label="Theme mode"
          value={mode}
          onValueChange={(v) => setMode(v === 'light' ? 'light' : 'dark')}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
        />
      </div>

      <div
        className="rounded-lg border border-border-default bg-bg-raised p-4"
        data-testid="theme-preview"
      >
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-accent-primary" />
          <span className="text-body text-text-primary">Live preview</span>
        </div>
        <p className="mt-1 text-footnote text-text-muted">
          The whole app is already using the {flavor} · {mode} theme. You can change it anytime from
          the top bar or Settings.
        </p>
      </div>
    </div>
  );
}
