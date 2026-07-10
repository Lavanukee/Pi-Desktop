/**
 * Friendly auto-download card (round-12 W3). When the Auto router — or an
 * explicit footer tier pick — resolves to a capability tier whose model isn't on
 * disk, the router parks a `pendingDownload` and this small card floats just
 * above the composer footer:
 *
 *   Download intelligent model
 *   qwen3.6 27b · 16 GB                      [ Download ]
 *
 * No jargon, no push to the Model Manager — a regular user downloads (or
 * dismisses) right in the flow. On a confirmed download the router switches to
 * the new model automatically. Rendered inside {@link ComposerFooter} (anchored
 * to the model chip), so it stays in W3's scope.
 */
import { Button, IconButton, IconClose, Spinner } from '@pi-desktop/ui';
import { useLlmStore } from '../state/llm-store';
import { useAutoDownloadPrompt, useModelSelectionStore } from '../state/model-selection-store';
import { downloadPendingTier, downloadPromptView } from './auto-router';

export function AutoDownloadPrompt() {
  const pending = useAutoDownloadPrompt();
  const download = useLlmStore((s) => s.download);
  const view = downloadPromptView(pending);
  if (view === null) return null;

  const downloading = download !== null && download.modelId === view.modelId;
  const pct =
    downloading && download?.fraction !== null && download?.fraction !== undefined
      ? Math.round(download.fraction * 100)
      : null;

  return (
    <div
      className="absolute bottom-full left-0 z-40 mb-2 w-72 rounded-xl border border-border-subtle bg-surface-raised p-3 shadow-popover"
      data-testid="auto-download-prompt"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body text-text-primary">{view.title}</span>
          <span className="truncate text-footnote text-text-muted">{view.detail}</span>
        </div>
        <IconButton
          size="sm"
          aria-label="Dismiss"
          onClick={() => useModelSelectionStore.getState().dismissDownload()}
          data-testid="auto-download-dismiss"
        >
          <IconClose size={14} />
        </IconButton>
      </div>
      <div className="mt-2.5 flex justify-end">
        <Button
          variant="primary"
          size="sm"
          className="gap-1.5"
          disabled={downloading}
          onClick={() => void downloadPendingTier()}
          data-testid="auto-download-btn"
        >
          {downloading ? (
            <>
              <Spinner size={12} />
              {pct !== null ? `Downloading… ${pct}%` : 'Downloading…'}
            </>
          ) : (
            'Download'
          )}
        </Button>
      </div>
    </div>
  );
}
