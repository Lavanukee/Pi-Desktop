/**
 * Generation capabilities — reflects + edits the onboarding choices. Installs
 * are still deferred (v0.2 gen services); this just persists the intent.
 */
import { Checkbox, IconCamera, IconImage, IconMic, IconPuzzle } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import type { GenerationCapabilities } from '../../../electron/settings/settings-contract';
import { useSettingsStore } from '../../state/settings-store';
import { SettingSection } from '../parts';

const CAPS: Array<{
  key: keyof GenerationCapabilities;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    key: 'image',
    title: 'Image generation',
    description: 'Create and edit images.',
    icon: <IconImage />,
  },
  {
    key: 'video',
    title: 'Video generation',
    description: 'Short clips and motion graphics.',
    icon: <IconCamera />,
  },
  {
    key: 'audio',
    title: 'Audio generation',
    description: 'Speech and sound, model permitting.',
    icon: <IconMic />,
  },
  {
    key: 'threeD',
    title: '3D generation',
    description: 'Meshes you can view and export.',
    icon: <IconPuzzle />,
  },
];

export function CapabilitiesPanel() {
  const capabilities = useSettingsStore((s) => s.settings.capabilities);
  const update = useSettingsStore((s) => s.update);

  return (
    <SettingSection
      title="Capabilities"
      description="Generation features to enable. Models download in the background when you first use one."
    >
      <div className="flex flex-col gap-3">
        {CAPS.map((cap) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox (custom control)
          <label
            key={cap.key}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-border-default bg-bg-raised p-3"
          >
            <Checkbox
              checked={capabilities[cap.key]}
              onCheckedChange={(v) => void update({ capabilities: { [cap.key]: v === true } })}
              data-testid={`settings-capability-${cap.key}`}
            />
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-inset text-text-secondary">
              {cap.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-body text-text-primary">{cap.title}</span>
              <span className="block text-footnote text-text-muted">{cap.description}</span>
            </span>
          </label>
        ))}
      </div>
    </SettingSection>
  );
}
