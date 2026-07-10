/**
 * Step 4 — experience gauge. Three levels that set the tutorial flag + the pi
 * permission mode the harness starts in (see mapExperience).
 */
import { IconGauge, IconSparkles, IconSpeed } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { type ExperienceLevel, mapExperience } from '../onboarding-logic';
import { SelectCard } from '../SelectCard';
import { useOnboardingStore } from '../useOnboarding';

const OPTIONS: Array<{
  value: ExperienceLevel;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    value: 'new',
    title: "I've never run a local model",
    description: 'Show me the tutorial and review every action before it runs.',
    icon: <IconSparkles />,
  },
  {
    value: 'knows-llamacpp',
    title: 'I know what llama.cpp is',
    description: 'Skip the tutorial. Flag risky commands, but keep things moving.',
    icon: <IconGauge />,
  },
  {
    value: 'no-tutorial',
    title: 'Leave me alone, no tutorial',
    description: 'No hand-holding. Run actions without asking (you can dial this back later).',
    icon: <IconSpeed />,
  },
];

const PERMISSION_LABEL: Record<ReturnType<typeof mapExperience>['permissionMode'], string> = {
  'review-all': 'review every action',
  reviewer: 'flag risky commands',
  bypass: 'run without asking',
};

export function ExperienceStep() {
  const experience = useOnboardingStore((s) => s.experience);
  const setExperience = useOnboardingStore((s) => s.setExperience);

  return (
    <div className="flex flex-col gap-3" role="radiogroup" aria-label="Experience level">
      {OPTIONS.map((opt) => {
        const mapping = mapExperience(opt.value);
        return (
          <SelectCard
            key={opt.value}
            data-testid={`experience-${opt.value}`}
            selected={experience === opt.value}
            onSelect={() => setExperience(opt.value)}
            icon={opt.icon}
            title={opt.title}
            description={
              <>
                {opt.description}
                <span className="mt-1 block text-caption text-text-muted">
                  Permissions: {PERMISSION_LABEL[mapping.permissionMode]}
                  {mapping.tutorial ? ' · tutorial on' : ' · tutorial off'}
                </span>
              </>
            }
          />
        );
      })}
    </div>
  );
}
