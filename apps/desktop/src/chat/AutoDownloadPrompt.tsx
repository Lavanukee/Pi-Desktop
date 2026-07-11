/**
 * Friendly auto-download prompt (round-14 rewrite). When the Auto router — or an
 * explicit footer tier pick — resolves to a capability tier whose model isn't on
 * disk, the router parks a `pendingDownload` and this surfaces a CENTERED Dialog
 * (scrim + zoom-in card + corner X) instead of the old dark pill that floated,
 * chrome-less and jargon-heavy, above the model chip:
 *
 *   ┌───────────────────────────────────────────── ✕ ┐
 *   │  Qwen3.6 27B   [🛡 Verified] [✦ Recommended]     │
 *   │  16 GB   Vision   MTP                             │
 *   │  (speedometer) slow response speed               │
 *   │  [         Download         ]                     │
 *   └──────────────────────────────────────────────────┘
 *
 * A regular user sees the model's identity, trust (verified/recommended),
 * footprint (size), modalities and rough speed at a glance, then downloads (or
 * dismisses) right in the flow — no push to the Model Manager. On a confirmed
 * download the router switches to the new model automatically. Enriched purely
 * from the already-loaded catalog (no IPC change). Mounted inside
 * {@link ComposerFooter}; the Dialog self-centers by portaling to <body>.
 */
import { Button, Dialog, DialogContent, DialogTitle, IconSpeed, Spinner } from '@pi-desktop/ui';
import { IconDownload } from '../settings/icons';
import { ModelTag, SpecPill } from '../settings/model-tags';
import { useLlmStore } from '../state/llm-store';
import { useAutoDownloadPrompt, useModelSelectionStore } from '../state/model-selection-store';
import { downloadPendingTier, formatTierBytes, tierSpeed } from './auto-router';

export function AutoDownloadPrompt() {
  const pending = useAutoDownloadPrompt();
  const download = useLlmStore((s) => s.download);
  const catalog = useLlmStore((s) => s.catalog);
  const recommendedModelId = useLlmStore((s) => s.recommendedModelId);

  // Closing the Dialog (corner X, Esc, or scrim click) dismisses the prompt.
  const onOpenChange = (open: boolean) => {
    if (!open) useModelSelectionStore.getState().dismissDownload();
  };

  if (pending === null) return null;
  const { tier, pick } = pending;

  // Cross-lookup the loaded catalog for the richer attributes the tier pick
  // doesn't carry (verified / recommended / audio) — lighter than an IPC change.
  const entry = catalog.find((m) => m.id === pick.modelId);
  const recommended = entry?.recommended === true || recommendedModelId === pick.modelId;
  const verified = entry?.verified === true || entry?.publisher?.reliable === true;
  // `input` is `('text'|'image')[]` today; widen so an eventual 'audio' modality
  // lights the Audio pill for free (forward-compat, no catalog change needed).
  const modalities = (entry?.input ?? []) as readonly string[];
  const size = formatTierBytes(pick.bytes);
  const speed = tierSpeed(tier);

  const downloading = download !== null && download.modelId === pick.modelId;
  const pct =
    downloading && download.fraction !== null ? Math.round(download.fraction * 100) : null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent showClose data-testid="auto-download-prompt">
        <div className="flex flex-col gap-4 p-5">
          {/* Identity + trust chips (kept clear of the corner X). */}
          <div className="flex flex-col gap-2 pr-8">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>{pick.displayName}</DialogTitle>
              {verified ? (
                <ModelTag kind="reliable" data-testid="download-verified">
                  Verified
                </ModelTag>
              ) : null}
              {recommended ? (
                <ModelTag kind="recommended" data-testid="download-recommended">
                  Recommended
                </ModelTag>
              ) : null}
            </div>

            {/* Footprint + modality + speed-method chips. */}
            <div className="flex flex-wrap items-center gap-1.5">
              {size.length > 0 ? (
                <ModelTag kind="size" data-testid="download-size">
                  {size}
                </ModelTag>
              ) : null}
              {pick.vision ? <ModelTag kind="vision">Vision</ModelTag> : null}
              {modalities.includes('audio') ? <ModelTag kind="audio">Audio</ModelTag> : null}
              {pick.spec !== undefined ? <SpecPill method={pick.spec} /> : null}
            </div>
          </div>

          {/* Rough response speed — a speedometer + fast/balanced/slow word. */}
          <div
            className="flex items-center gap-1.5 text-footnote text-text-muted"
            data-testid="download-speed"
          >
            <IconSpeed size={16} />
            <span className="capitalize text-text-secondary">{speed}</span>
            <span>response speed</span>
          </div>

          {/* Big primary download, with a secondary Cancel while in-flight. */}
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              className="w-full gap-2"
              disabled={downloading}
              onClick={() => void downloadPendingTier()}
              data-testid="auto-download-btn"
            >
              {downloading ? (
                <>
                  <Spinner size={14} />
                  {pct !== null ? `Downloading… ${pct}%` : 'Downloading…'}
                </>
              ) : (
                <>
                  <IconDownload size={16} />
                  Download
                </>
              )}
            </Button>
            {downloading ? (
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => void useLlmStore.getState().cancelDownload()}
                data-testid="auto-download-cancel"
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
