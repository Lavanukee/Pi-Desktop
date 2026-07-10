/**
 * Model Manager entry for the Apple Foundation Models on-device model. Shown
 * ONLY when the main-process capability gate reports it available. Unlike a
 * catalog model there is no download and no server: it ships with the OS, so the
 * card offers just a "Set active" that writes the afm block into models.json,
 * restarts pi, and points it at the on-device model (state/afm-model.ts). Active
 * state tracks pi's current provider.
 */
import { Badge, Button } from '@pi-desktop/ui';
import { useState } from 'react';
import type { AfmAvailabilityInfo } from '../../electron/afm/afm-contract';
import { activateAppleModel } from '../state/afm-model';
import { usePiStore } from '../state/pi-slice';
import { applyModelEffortDefault } from '../state/settings-store';
import { IconCpu, IconPlay } from './icons';
import { EffortDefaultSelect, FavoriteStar } from './model-controls';

/** Stable id the Apple on-device entry uses for favorites + effort defaults. */
export const AFM_MODEL_ID = 'afm';

export function AfmModelCard({
  availability,
  advanced = false,
}: {
  availability: AfmAvailabilityInfo;
  advanced?: boolean;
}) {
  const activeProvider = usePiStore((s) => s.agent.model?.provider);
  const isActive = activeProvider === 'afm';
  const [busy, setBusy] = useState(false);

  const contextK = Math.max(1, Math.round(availability.contextWindow / 1000));

  const onSetActive = async () => {
    setBusy(true);
    try {
      await applyModelEffortDefault(AFM_MODEL_ID);
      await activateAppleModel();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border-default bg-bg-raised p-4"
      data-testid="afm-model-card"
      data-active={isActive ? 'true' : 'false'}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium text-text-primary">
              Apple Intelligence (on-device)
            </span>
            {isActive ? (
              <Badge tone="success" size="sm" data-testid="afm-active-badge">
                Active
              </Badge>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-muted">
            <span className="flex items-center gap-1">
              <IconCpu size={13} /> On-device
            </span>
            <span>·</span>
            <span>no download</span>
            <span>·</span>
            <span>{contextK}k context</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge tone="accent" size="sm" data-testid="afm-badge">
            Apple Intelligence
          </Badge>
          <FavoriteStar modelId={AFM_MODEL_ID} />
        </div>
      </div>

      <p className="text-footnote text-text-secondary">
        Runs entirely on this Mac using Apple&apos;s built-in Foundation model — no network, no
        download. Best for quick chat; tool use and the {contextK}k context window are limited.
      </p>

      <div className="flex items-center justify-end gap-2">
        {isActive ? (
          <span className="text-caption text-text-muted">Selected as the active model</span>
        ) : (
          <Button
            size="sm"
            variant="accent"
            loading={busy}
            data-testid="afm-set-active"
            onClick={onSetActive}
          >
            <IconPlay size={13} /> Set active
          </Button>
        )}
      </div>

      {advanced ? (
        <div
          className="flex items-center justify-between gap-3 border-t border-border-default pt-3"
          data-testid={`advanced-${AFM_MODEL_ID}`}
        >
          <span className="text-caption text-text-secondary">Default effort</span>
          <EffortDefaultSelect modelId={AFM_MODEL_ID} />
        </div>
      ) : null}
    </div>
  );
}
