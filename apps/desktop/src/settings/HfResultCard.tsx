/**
 * One Hugging Face search result in the Browse-HF view. Shows the repo summary
 * (name/author, downloads, likes, tags, gated + updated), a favorites star, and
 * a "Browse GGUF files" toggle that opens the quant picker for the repo. Each
 * quant row carries its size + a RAM-fit badge + mmproj/MTP flags and a Download
 * that adapts the pick into the local catalog (hf:register) and downloads it
 * through the existing downloader — after which it lives in the Recommended view.
 */
import { Badge, Button, ProgressBar, Spinner } from '@pi-desktop/ui';
import { useState } from 'react';
import type { HfGgufFileDTO, HfModelHitDTO } from '../../electron/ipc-contract';
import { useHfStore } from '../state/hf-store';
import { useLlmStore } from '../state/llm-store';
import { activateLocalModel } from '../state/local-model';
import { applyModelEffortDefault } from '../state/settings-store';
import { IconDownload, IconLock, IconPlay } from './icons';
import { FavoriteStar } from './model-controls';
import { formatBytes, isReliablePublisher, percent, ramVerdict } from './model-manager-logic';
import { hfHasAudio, hfHasVision, ModelTag } from './model-tags';

/** Context window HF repos are sized/registered against (HF doesn't expose it). */
const HF_CONTEXT_WINDOW = 8192;

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatUpdated(iso: string | undefined): string | null {
  if (iso === undefined) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Split a repo's files into the main GGUF quants and the mmproj / MTP siblings. */
function splitFiles(files: HfGgufFileDTO[]): {
  quants: HfGgufFileDTO[];
  mmproj?: HfGgufFileDTO;
  mtp?: HfGgufFileDTO;
} {
  const mmproj = files.find((f) => f.mmproj === true);
  const mtp = files.find((f) => f.mtp === true);
  const quants = files.filter((f) => f.mmproj !== true && f.mtp !== true);
  return { quants, mmproj, mtp };
}

export function HfResultCard({ hit }: { hit: HfModelHitDTO }) {
  const selected = useHfStore((s) => s.selected);
  const files = useHfStore((s) => s.files);
  const filesStatus = useHfStore((s) => s.filesStatus);
  const filesError = useHfStore((s) => s.filesError);
  const gatedRepo = useHfStore((s) => s.gatedRepo);
  const selectRepo = useHfStore((s) => s.selectRepo);
  const clearSelection = useHfStore((s) => s.clearSelection);
  const addAndDownload = useHfStore((s) => s.addAndDownload);

  const hardware = useLlmStore((s) => s.hardware);
  const download = useLlmStore((s) => s.download);
  const downloadedIds = useLlmStore((s) => s.status.downloadedModelIds);

  const [busyQuant, setBusyQuant] = useState<string | null>(null);
  const [registeredId, setRegisteredId] = useState<string | null>(null);

  const isOpen = selected?.id === hit.id;
  const updated = formatUpdated(hit.updatedAt);
  const dl = registeredId !== null && download?.modelId === registeredId ? download : null;
  const isDownloaded = registeredId !== null && downloadedIds.includes(registeredId);

  const onToggleFiles = () => {
    if (isOpen) clearSelection();
    else void selectRepo(hit, HF_CONTEXT_WINDOW);
  };

  const onDownload = async (file: HfGgufFileDTO, siblings: ReturnType<typeof splitFiles>) => {
    setBusyQuant(file.quant ?? file.path);
    try {
      const id = await addAndDownload(hit, file, {
        mmproj: siblings.mmproj,
        mtpFile: siblings.mtp,
        contextWindow: HF_CONTEXT_WINDOW,
      });
      setRegisteredId(id);
    } finally {
      setBusyQuant(null);
    }
  };

  const onSetActive = async () => {
    if (registeredId === null) return;
    await applyModelEffortDefault(registeredId);
    await activateLocalModel(registeredId);
  };

  const siblings = splitFiles(files);

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border-default bg-bg-raised p-4"
      data-testid={`hf-result-${hit.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-body font-medium text-text-primary">{hit.name}</span>
            {isReliablePublisher(hit.author) ? (
              <ModelTag kind="reliable" data-testid={`hf-reliable-${hit.id}`}>
                Reliable
              </ModelTag>
            ) : null}
            {hit.gated ? (
              <ModelTag kind="gated" data-testid={`hf-gated-${hit.id}`}>
                Gated
              </ModelTag>
            ) : null}
            {hfHasVision(hit) ? <ModelTag kind="vision">Vision</ModelTag> : null}
            {hfHasAudio(hit) ? <ModelTag kind="audio">Audio</ModelTag> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-muted">
            <span>{hit.author}</span>
            <span>·</span>
            <span>{formatCount(hit.downloads)} downloads</span>
            <span>·</span>
            <span>{formatCount(hit.likes)} likes</span>
            {updated !== null ? (
              <>
                <span>·</span>
                <span>updated {updated}</span>
              </>
            ) : null}
          </div>
        </div>
        <FavoriteStar modelId={hit.id} />
      </div>

      {hit.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {hit.tags
            .filter((t) => t.toLowerCase() !== 'gguf')
            .slice(0, 5)
            .map((tag) => (
              <ModelTag key={tag} kind="neutral" icon={null}>
                {tag}
              </ModelTag>
            ))}
        </div>
      ) : null}

      <div>
        <Button
          size="sm"
          variant="outline"
          data-testid={`hf-browse-files-${hit.id}`}
          onClick={onToggleFiles}
        >
          {isOpen ? 'Hide files' : 'Browse GGUF files'}
        </Button>
      </div>

      {/* Quant picker for the open repo. */}
      {isOpen ? (
        <div className="flex flex-col gap-2" data-testid={`hf-files-${hit.id}`}>
          {filesStatus === 'loading' ? (
            <div className="flex items-center gap-2 py-2 text-caption text-text-muted">
              <Spinner size={13} /> Loading files…
            </div>
          ) : filesStatus === 'error' ? (
            <div className="flex items-center gap-2 text-caption text-status-danger-fg">
              <IconLock size={13} />
              {gatedRepo
                ? 'This repo is gated — accept its licence on Hugging Face and add an HF token below.'
                : (filesError ?? 'Could not load files.')}
            </div>
          ) : siblings.quants.length === 0 ? (
            <div className="py-2 text-caption text-text-muted">
              No GGUF quants found in this repo.
            </div>
          ) : (
            siblings.quants.map((file) => {
              const ram = ramVerdict(file.minRamGB ?? 0, hardware?.totalRamGB ?? 0);
              const rowBusy = busyQuant === (file.quant ?? file.path);
              return (
                <div
                  key={file.path}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-base p-2.5"
                  data-testid={`hf-quant-${hit.id}-${file.quant ?? 'file'}`}
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ModelTag kind="quant" icon={null}>
                        {file.quant ?? file.path}
                      </ModelTag>
                      <ModelTag kind="size" icon={null}>
                        {formatBytes(file.sizeBytes ?? 0)}
                      </ModelTag>
                      {siblings.mmproj !== undefined ? (
                        <ModelTag kind="vision">Vision</ModelTag>
                      ) : null}
                      {siblings.mtp !== undefined ? <ModelTag kind="mtp">MTP</ModelTag> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={ram.tone} size="sm">
                      {ram.label}
                    </Badge>
                    <Button
                      size="sm"
                      variant="accent"
                      loading={rowBusy}
                      disabled={download !== null || busyQuant !== null}
                      data-testid={`hf-download-${hit.id}-${file.quant ?? 'file'}`}
                      onClick={() => void onDownload(file, siblings)}
                    >
                      <IconDownload size={13} /> Download
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : null}

      {/* Live progress + set-active for a file added from this card. */}
      {dl !== null ? (
        <div className="flex flex-col gap-1" data-testid={`hf-download-progress-${hit.id}`}>
          <ProgressBar value={dl.fraction} />
          <span className="text-caption text-text-muted">
            {dl.paused
              ? 'Paused'
              : percent(dl.fraction) !== null
                ? `Downloading… ${percent(dl.fraction)}%`
                : 'Starting…'}
          </span>
        </div>
      ) : isDownloaded ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption text-status-success-fg">Added to your models</span>
          <Button
            size="sm"
            variant="accent"
            data-testid={`hf-set-active-${hit.id}`}
            onClick={() => void onSetActive()}
          >
            <IconPlay size={13} /> Set active
          </Button>
        </div>
      ) : null}
    </div>
  );
}
