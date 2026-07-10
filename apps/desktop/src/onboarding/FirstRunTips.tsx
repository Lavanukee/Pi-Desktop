/**
 * First-run tips overlay — the visible consumer of the onboarding `tutorial`
 * flag (mapExperience: newer users get `tutorial: true`). A small, dismissible
 * coach-mark card that appears once, bottom-left, when the persisted onboarding
 * choices asked for the tutorial and the user hasn't dismissed it yet. Dismissal
 * persists to localStorage so it never nags. Power users (tutorial: false) never
 * see it. Non-modal: it never covers the composer or blocks input.
 *
 * Rendered by App over the chat view; self-contained (fetches its own state) so
 * App only mounts it.
 */
import { Button, IconChevronRight, IconClose, IconSparkles } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';

const DISMISS_KEY = 'pi.desktop.tips.dismissed';

/** Clear the dismissal so the tips show again (used by "Redo onboarding"). */
export function resetFirstRunTips(): void {
  try {
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    // ignore — a blocked localStorage just means tips won't re-show.
  }
}

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

const TIPS: Array<{ title: string; body: string }> = [
  {
    title: 'Pick a local model',
    body: 'Open the model chip in the composer to download and run an on-device model.',
  },
  {
    title: 'Add context with @',
    body: 'Type @ in the composer to attach files, or drop them onto the window.',
  },
  {
    title: 'Give Pi tools & skills',
    body: 'Open Connectors to enable MCP tools and saved skill playbooks.',
  },
];

export function FirstRunTips() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (isDismissed()) return;
    window.piDesktop
      .invoke('onboarding:get-state', undefined)
      .then((state) => {
        // Show only when the wizard recorded that this user wants the tutorial.
        if (!cancelled && state.choices?.tutorial === true) setVisible(true);
      })
      .catch(() => {
        // No state / read error → keep the overlay hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore
    }
    setVisible(false);
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-40 flex items-end justify-start p-4"
      data-testid="first-run-tips"
    >
      <div className="pointer-events-auto w-[320px] max-w-full rounded-2xl border border-border-default bg-bg-raised p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-body text-text-primary">
            <span className="text-accent-primary">
              <IconSparkles size={16} />
            </span>
            Getting started
          </span>
          <button
            type="button"
            aria-label="Dismiss tips"
            data-testid="first-run-tips-close"
            onClick={dismiss}
            className="rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <IconClose size={14} />
          </button>
        </div>

        <ul className="flex flex-col gap-2.5">
          {TIPS.map((tip) => (
            <li key={tip.title} className="flex gap-2">
              <span className="mt-0.5 shrink-0 text-text-muted">
                <IconChevronRight size={14} />
              </span>
              <span className="min-w-0">
                <span className="block text-footnote text-text-primary">{tip.title}</span>
                <span className="block text-footnote text-text-muted">{tip.body}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            variant="secondary"
            data-testid="first-run-tips-dismiss"
            onClick={dismiss}
          >
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
