/**
 * Step 5 — generation capabilities. Checkboxes are persisted with the onboarding
 * choices; the actual model/tool installs are deferred (they feed the llm:*
 * catalog + Model Manager later). Surfaces the hardware-recommended chat model
 * from the same llm:* catalog so the model step ties in without duplicating W10.
 */
import { Checkbox, IconCamera, IconImage, IconMic, IconPuzzle } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import type { GenerationCapabilities } from '../../../electron/import/import-contract';
import { useLlmStore } from '../../state/llm-store';
import { useOnboardingStore } from '../useOnboarding';

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
    description: 'Meshes and models you can view + export.',
    icon: <IconPuzzle />,
  },
];

export function CapabilitiesStep() {
  const capabilities = useOnboardingStore((s) => s.capabilities);
  const toggleCapability = useOnboardingStore((s) => s.toggleCapability);

  const catalog = useLlmStore((s) => s.catalog);
  const recommendedModelId = useLlmStore((s) => s.recommendedModelId);
  const hardware = useLlmStore((s) => s.hardware);
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const recommended = catalog.find((m) => m.id === recommendedModelId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {CAPS.map((cap) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox (custom control)
          <label
            key={cap.key}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-border-default bg-bg-raised p-3"
          >
            <Checkbox
              checked={capabilities[cap.key]}
              onCheckedChange={() => toggleCapability(cap.key)}
              data-testid={`capability-${cap.key}`}
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

      <p className="text-caption text-text-muted">
        These download in the background later — nothing is installed now.
      </p>

      {recommended != null ? (
        <div
          className="rounded-lg border border-status-info-border bg-status-info-bg p-3 text-status-info-fg"
          data-testid="recommended-model"
        >
          <span className="text-footnote">
            Recommended chat model for {hardware?.chip ?? 'your Mac'}: {recommended.displayName} (
            {recommended.minRamGB} GB). Set it up in Model Manager after setup.
          </span>
        </div>
      ) : null}
    </div>
  );
}
