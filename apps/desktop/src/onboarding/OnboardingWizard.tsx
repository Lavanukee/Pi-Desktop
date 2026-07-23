/**
 * First-run onboarding wizard. Mounts before ChatApp on first run (App.tsx
 * gate), walks source → import → theme → experience → capabilities, then applies
 * the selected imports + persists the choices and hands off to chat.
 */
import { Button, Spinner } from '@pi-desktop/ui';
import { useEffect } from 'react';
import { cx } from './cx';
import { CapabilitiesStep } from './steps/CapabilitiesStep';
import { ExperienceStep } from './steps/ExperienceStep';
import { ImportStep } from './steps/ImportStep';
import { SourceStep } from './steps/SourceStep';
import { ThemeStep } from './steps/ThemeStep';
import { ONBOARDING_STEPS, useOnboardingStore } from './useOnboarding';

const STEP_META: Record<(typeof ONBOARDING_STEPS)[number], { title: string; subtitle: string }> = {
  source: {
    title: 'Welcome to Bobble',
    subtitle: "Where are you coming from? We'll carry your setup across.",
  },
  import: { title: 'Bring your setup', subtitle: 'Choose what to import from your old app.' },
  theme: {
    title: 'Make it yours',
    subtitle: 'We matched the look to your app — change it anytime.',
  },
  experience: {
    title: 'How much guidance?',
    subtitle: 'This sets the tutorial and your default permissions.',
  },
  capabilities: {
    title: 'What do you want to create?',
    subtitle: 'Switch on generation features. Installs happen later.',
  },
};

function StepBody({ index }: { index: number }) {
  switch (ONBOARDING_STEPS[index]) {
    case 'source':
      return <SourceStep />;
    case 'import':
      return <ImportStep />;
    case 'theme':
      return <ThemeStep />;
    case 'experience':
      return <ExperienceStep />;
    case 'capabilities':
      return <CapabilitiesStep />;
    default:
      return null;
  }
}

export function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const step = useOnboardingStore((s) => s.step);
  const loading = useOnboardingStore((s) => s.loading);
  const finishing = useOnboardingStore((s) => s.finishing);
  const canProceed = useOnboardingStore((s) => s.canProceed());
  const load = useOnboardingStore((s) => s.load);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const finish = useOnboardingStore((s) => s.finish);

  useEffect(() => {
    void load();
  }, [load]);

  const isLast = step === ONBOARDING_STEPS.length - 1;
  const meta = STEP_META[ONBOARDING_STEPS[step] ?? 'source'];

  return (
    <div className="flex h-full flex-col bg-bg-base" data-testid="onboarding-wizard">
      {/* Draggable strip clearing the macOS traffic lights (frameless window). */}
      <div className="h-10 shrink-0 [-webkit-app-region:drag]" />

      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-10">
        {loading ? (
          <div className="flex items-center gap-2 text-text-muted" data-testid="onboarding-loading">
            <Spinner size={16} />
            <span className="text-footnote">Looking for your apps…</span>
          </div>
        ) : (
          <div className="flex w-full max-w-[560px] flex-col">
            {/* Progress dots */}
            <div className="mb-6 flex items-center justify-center gap-2" aria-hidden>
              {ONBOARDING_STEPS.map((id, i) => (
                <span
                  key={id}
                  className={cx(
                    'h-1.5 rounded-full transition-all',
                    i === step
                      ? 'w-6 bg-accent-primary'
                      : i < step
                        ? 'w-1.5 bg-accent-primary'
                        : 'w-1.5 bg-border-strong',
                  )}
                />
              ))}
            </div>

            <div className="mb-1 text-caption text-text-muted">
              Step {step + 1} of {ONBOARDING_STEPS.length}
            </div>
            <h1 className="text-heading text-text-primary">{meta.title}</h1>
            <p className="mt-1 mb-5 text-body text-text-muted">{meta.subtitle}</p>

            {/* key restarts the enter animation each step (reduced-motion safe) */}
            <div key={step} className="pd-onboard-step">
              <StepBody index={step} />
            </div>

            <div className="mt-6 flex items-center justify-between">
              <Button variant="ghost" onClick={back} disabled={step === 0 || finishing}>
                Back
              </Button>
              {isLast ? (
                <Button
                  variant="accent"
                  data-testid="onboarding-finish"
                  loading={finishing}
                  onClick={() => void finish(onComplete)}
                >
                  Finish setup
                </Button>
              ) : (
                <Button
                  variant="accent"
                  data-testid="onboarding-next"
                  disabled={!canProceed}
                  onClick={next}
                >
                  Continue
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
