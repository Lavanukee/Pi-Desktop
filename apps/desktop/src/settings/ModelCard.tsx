/**
 * One model card in the Model Manager: RAM-fit badge, size, quant picker,
 * MTP/vision flags, recommended badge, and the full lifecycle affordances —
 * download (with pause/resume/cancel + live %/speed), verify, delete, set-active
 * (download+start+re-point pi), and stop, plus live running/loading/error status
 * with port + TPS for the active model.
 */
import {
  Badge,
  Button,
  ProgressBar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Spinner,
} from '@pi-desktop/ui';
import { useState } from 'react';
import type { LlmCatalogEntry } from '../../electron/ipc-contract';
import { useLlmStore } from '../state/llm-store';
import { activateLocalModel } from '../state/local-model';
import {
  IconCheckCircle,
  IconDownload,
  IconPause,
  IconPlay,
  IconStop,
  IconTrash,
  IconWarning,
} from './icons';
import {
  displaySizeBytes,
  formatBytes,
  formatSpeed,
  percent,
  ramVerdict,
} from './model-manager-logic';

function portOf(baseUrl: string | null): string | null {
  if (baseUrl === null) return null;
  try {
    return new URL(baseUrl).port || null;
  } catch {
    return null;
  }
}

export function ModelCard({ entry }: { entry: LlmCatalogEntry }) {
  const status = useLlmStore((s) => s.status);
  const hardware = useLlmStore((s) => s.hardware);
  const download = useLlmStore((s) => s.download);
  const store = useLlmStore;

  const [quant, setQuant] = useState(entry.quants[0]?.quant ?? '');
  const [busy, setBusy] = useState<null | 'activate' | 'delete' | 'verify' | 'stop'>(null);
  const [verify, setVerify] = useState<null | 'ok' | 'bad'>(null);

  const isActive = status.serverRunning && status.model?.id === entry.id;
  const isLoading = isActive && status.phase === 'starting';
  // Narrow to this card's download so the progress block sees a non-null object.
  const dl = download !== null && download.modelId === entry.id ? download : null;
  const ram = ramVerdict(entry.minRamGB, hardware?.totalRamGB ?? 0);
  const sizeBytes = displaySizeBytes(entry, quant);
  const tps = status.metrics?.avgTps ?? status.metrics?.lastTps;
  const port = isActive ? portOf(status.baseUrl) : null;

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<unknown>) => {
    setBusy(kind);
    setVerify(null);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const onSetActive = () => run('activate', () => activateLocalModel(entry.id, quant));
  const onDelete = () => run('delete', () => store.getState().deleteModel(entry.id));
  const onStop = () => run('stop', () => store.getState().stopServer());
  const onVerify = () =>
    run('verify', async () => {
      const res = await store.getState().verifyModel(entry.id, quant);
      setVerify(res.ok ? 'ok' : 'bad');
    });
  const onDownload = () => void store.getState().downloadModel(entry.id, quant);

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border-default bg-bg-raised p-4"
      data-testid={`model-card-${entry.id}`}
      data-active={isActive ? 'true' : 'false'}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium text-text-primary">{entry.displayName}</span>
            {entry.recommended ? (
              <Badge tone="accent" size="sm" data-testid={`recommended-badge-${entry.id}`}>
                Recommended
              </Badge>
            ) : null}
            {isActive ? (
              <Badge tone="success" size="sm" data-testid={`active-badge-${entry.id}`}>
                Active
              </Badge>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-muted">
            <span>{formatBytes(sizeBytes)}</span>
            <span>·</span>
            <span>{(entry.contextWindow / 1000).toFixed(0)}K context</span>
            <span>·</span>
            <span>{entry.license}</span>
            {entry.mtp ? (
              <Badge tone="info" size="sm">
                MTP
              </Badge>
            ) : null}
            {entry.vision ? (
              <Badge tone="info" size="sm">
                Vision
              </Badge>
            ) : null}
          </div>
        </div>
        <Badge tone={ram.tone} size="sm" data-testid={`ram-badge-${entry.id}`}>
          {ram.label}
        </Badge>
      </div>

      {/* Live status for the active model. */}
      {isActive ? (
        <div className="flex items-center gap-2 text-caption" data-testid={`status-${entry.id}`}>
          {isLoading ? (
            <>
              <Spinner size={12} />
              <span className="text-text-muted">Loading…</span>
            </>
          ) : status.phase === 'error' ? (
            <span className="flex items-center gap-1 text-status-danger-fg">
              <IconWarning size={13} /> {status.error ?? 'Server error'}
            </span>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-status-success-fg" />
              <span className="text-text-secondary">Running{port ? ` · :${port}` : ''}</span>
              {tps !== undefined ? (
                <span className="text-text-muted">· {tps.toFixed(1)} tok/s</span>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* Download progress with pause/resume/cancel. */}
      {dl !== null ? (
        <div className="flex flex-col gap-2" data-testid={`download-${entry.id}`}>
          <ProgressBar value={dl.fraction} />
          <div className="flex items-center justify-between text-caption text-text-muted">
            <span>
              {dl.paused
                ? 'Paused'
                : percent(dl.fraction) !== null
                  ? `${percent(dl.fraction)}%`
                  : 'Starting…'}
              {dl.total !== null ? ` · ${formatBytes(dl.received)} / ${formatBytes(dl.total)}` : ''}
              {!dl.paused && formatSpeed(dl.bytesPerSec) ? ` · ${formatSpeed(dl.bytesPerSec)}` : ''}
            </span>
            <span className="flex items-center gap-1">
              {dl.paused ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void store.getState().resumeDownload()}
                >
                  <IconPlay size={13} /> Resume
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void store.getState().pauseDownload()}
                >
                  <IconPause size={13} /> Pause
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                data-testid={`cancel-download-${entry.id}`}
                onClick={() => void store.getState().cancelDownload()}
              >
                Cancel
              </Button>
            </span>
          </div>
        </div>
      ) : null}

      {/* Action row. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {entry.quants.length > 1 ? (
          <Select value={quant} onValueChange={setQuant}>
            <SelectTrigger
              className="h-7 min-w-[130px]"
              aria-label="Quantization"
              data-testid={`quant-${entry.id}`}
            />
            <SelectContent>
              {entry.quants.map((q) => (
                <SelectItem key={q.quant} value={q.quant}>
                  {q.quant} · {formatBytes(q.bytes)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-caption text-text-muted">{entry.quants[0]?.quant}</span>
        )}

        <div className="flex items-center gap-2">
          {verify === 'ok' ? (
            <span className="flex items-center gap-1 text-caption text-status-success-fg">
              <IconCheckCircle size={13} /> Verified
            </span>
          ) : verify === 'bad' ? (
            <span className="flex items-center gap-1 text-caption text-status-danger-fg">
              <IconWarning size={13} /> Checksum failed
            </span>
          ) : null}

          {isActive ? (
            <Button size="sm" variant="outline" loading={busy === 'stop'} onClick={onStop}>
              <IconStop size={13} /> Stop
            </Button>
          ) : dl !== null ? null : entry.downloaded ? (
            <>
              <Button size="sm" variant="ghost" loading={busy === 'verify'} onClick={onVerify}>
                Verify
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === 'delete'}
                data-testid={`delete-${entry.id}`}
                onClick={onDelete}
              >
                <IconTrash size={13} /> Delete
              </Button>
              <Button
                size="sm"
                variant="accent"
                loading={busy === 'activate'}
                data-testid={`set-active-${entry.id}`}
                onClick={onSetActive}
              >
                <IconPlay size={13} /> Set active
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="accent"
              disabled={download !== null}
              data-testid={`download-${entry.id}-btn`}
              onClick={onDownload}
            >
              <IconDownload size={13} /> Download
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
