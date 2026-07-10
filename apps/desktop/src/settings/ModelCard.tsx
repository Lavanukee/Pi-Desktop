/**
 * One DE-DUPLICATED model card in the Model Manager (round-12): ONE card per
 * model, with a VARIANT dropdown [MTP / DFlash / EAGLE-3] and a QUANT dropdown
 * [Q2 … Q8] that together resolve to the concrete repo/file the single
 * Download/Start action acts on. Plus: RAM-fit badge, reliable-publisher label +
 * publisher handle, an engine badge (llama.cpp / MLX), the speed-method + vision
 * pills, and the full lifecycle affordances — download (pause/resume/cancel +
 * live %/speed), verify, delete, set-active (download+start+re-point pi), stop,
 * and live running/loading/error status with port + TPS for the active model.
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
import type { HfGgufFileDTO } from '../../electron/ipc-contract';
import { useLlmStore } from '../state/llm-store';
import { activateLocalModel } from '../state/local-model';
import { applyModelEffortDefault, useEnginePreference } from '../state/settings-store';
import {
  IconCheckCircle,
  IconDownload,
  IconPause,
  IconPlay,
  IconStop,
  IconTrash,
  IconWarning,
} from './icons';
import { EffortDefaultSelect, FavoriteStar } from './model-controls';
import {
  defaultVariant,
  formatBytes,
  formatSpeed,
  type ModelGroup,
  mergeQuantLadder,
  percent,
  ramVerdict,
  type SpecMethod,
  variantEntry,
} from './model-manager-logic';
import { ModelTag, SpecPill } from './model-tags';

function portOf(baseUrl: string | null): string | null {
  if (baseUrl === null) return null;
  try {
    return new URL(baseUrl).port || null;
  } catch {
    return null;
  }
}

/** Human label for the inference engine badge. */
function engineLabel(engine: string | undefined): string {
  return engine === 'mlx' ? 'MLX' : 'llama.cpp';
}

export function ModelCard({
  group,
  advanced = false,
}: {
  group: ModelGroup;
  /** Reveal the power-knob details block (repo/variant/quant/context/effort). */
  advanced?: boolean;
}) {
  const status = useLlmStore((s) => s.status);
  const hardware = useLlmStore((s) => s.hardware);
  const download = useLlmStore((s) => s.download);
  const enginePref = useEnginePreference();
  const store = useLlmStore;

  // model → variant → quant. The variant selects which concrete entry (repo)
  // the actions act on; the quant selects the file within it.
  const [variant, setVariant] = useState<SpecMethod>(defaultVariant(group));
  const [quant, setQuant] = useState<string>('');
  // Live Q2…Q8 ladders fetched per-repo via hf:list-files (merged over the known
  // catalog quants). Lazy: only when a quant dropdown is first opened.
  const [ladders, setLadders] = useState<Record<string, HfGgufFileDTO[]>>({});
  const [busy, setBusy] = useState<null | 'activate' | 'delete' | 'verify' | 'stop'>(null);
  const [verify, setVerify] = useState<null | 'ok' | 'bad'>(null);

  const primary = group.primary;
  const entry = variantEntry(group, variant);
  const quantOptions = mergeQuantLadder(entry.quants, ladders[entry.hfRepo ?? entry.id]);
  const effectiveQuant =
    quantOptions.find((q) => q.quant === quant)?.quant ?? quantOptions[0]?.quant ?? '';

  const isActive = status.serverRunning && status.model?.id === entry.id;
  const isLoading = isActive && status.phase === 'starting';
  const dl = download !== null && download.modelId === entry.id ? download : null;
  const ram = ramVerdict(primary.minRamGB, hardware?.totalRamGB ?? 0);
  const sizeBytes = quantOptions.find((q) => q.quant === effectiveQuant)?.bytes ?? 0;
  const tps = status.metrics?.avgTps ?? status.metrics?.lastTps;
  const port = isActive ? portOf(status.baseUrl) : null;

  const recommended = group.entries.some((e) => e.recommended);
  const reliable = primary.publisher?.reliable === true;
  const vision = group.entries.some((e) => e.vision);
  const engine = entry.engine ?? 'llamacpp';
  const showEngineBadge = advanced || engine === 'mlx' || enginePref === 'mlx';
  const downloaded = entry.downloaded;

  const loadLadder = (repo: string) => {
    if (ladders[repo] !== undefined) return;
    // Mark as fetched immediately (empty) so a failed/empty fetch never re-fires.
    setLadders((prev) => ({ ...prev, [repo]: prev[repo] ?? [] }));
    void window.piDesktop
      .invoke('hf:list-files', { repoId: repo, contextWindow: entry.contextWindow })
      .then((res) => {
        const files = (res.files ?? []).filter((f) => f.mmproj !== true && f.mtp !== true);
        if (files.length > 0) setLadders((prev) => ({ ...prev, [repo]: files }));
      })
      .catch(() => {
        /* offline / E2E — the known catalog quants already render. */
      });
  };

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<unknown>) => {
    setBusy(kind);
    setVerify(null);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const onSetActive = () =>
    run('activate', async () => {
      // Push this model's default effort into the harness before the (session-
      // preserving) restart so the fresh session boots with it applied.
      await applyModelEffortDefault(entry.id);
      return activateLocalModel(entry.id, effectiveQuant);
    });
  const onDelete = () => run('delete', () => store.getState().deleteModel(entry.id));
  const onStop = () => run('stop', () => store.getState().stopServer());
  const onVerify = () =>
    run('verify', async () => {
      const res = await store.getState().verifyModel(entry.id, effectiveQuant);
      setVerify(res.ok ? 'ok' : 'bad');
    });
  const onDownload = () => void store.getState().downloadModel(entry.id, effectiveQuant);

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border-default bg-bg-raised p-4"
      data-testid={`model-card-${primary.id}`}
      data-active={isActive ? 'true' : 'false'}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-body font-medium text-text-primary">{group.displayName}</span>
            {recommended ? (
              <ModelTag kind="recommended" data-testid={`recommended-badge-${primary.id}`}>
                Recommended
              </ModelTag>
            ) : null}
            {isActive ? (
              <Badge tone="success" size="sm" data-testid={`active-badge-${entry.id}`}>
                Active
              </Badge>
            ) : null}
            {entry.gated ? (
              <ModelTag kind="gated" data-testid={`gated-badge-${primary.id}`}>
                Gated
              </ModelTag>
            ) : null}
            {vision ? <ModelTag kind="vision">Vision</ModelTag> : null}
            {/* Speed pill reflects the SELECTED variant (MTP / DFlash / EAGLE-3). */}
            <SpecPill method={variant} />
            {reliable ? (
              <ModelTag kind="reliable" data-testid={`reliable-badge-${primary.id}`}>
                Reliable
              </ModelTag>
            ) : null}
            {showEngineBadge ? (
              <ModelTag kind="engine" data-testid={`engine-badge-${primary.id}`}>
                {engineLabel(engine)}
              </ModelTag>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-muted">
            <ModelTag kind="size" icon={null}>
              {formatBytes(sizeBytes)}
            </ModelTag>
            <span>{(primary.contextWindow / 1000).toFixed(0)}K context</span>
            <span>·</span>
            <span>{primary.license}</span>
            {primary.publisher !== undefined ? (
              <>
                <span>·</span>
                <span
                  className="font-mono text-text-secondary"
                  data-testid={`publisher-${primary.id}`}
                >
                  {primary.publisher.handle}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge tone={ram.tone} size="sm" data-testid={`ram-badge-${primary.id}`}>
            {ram.label}
          </Badge>
          <FavoriteStar modelId={primary.id} />
        </div>
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

      {/* Variant + quant selectors, then the action row. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {group.variants.length > 1 ? (
            <Select value={variant} onValueChange={(v) => setVariant(v as SpecMethod)}>
              <SelectTrigger
                className="h-7 min-w-[120px]"
                aria-label="Speed variant"
                data-testid={`variant-${primary.id}`}
              />
              <SelectContent>
                {group.variants.map((v) => (
                  <SelectItem key={v.method} value={v.method}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <ModelTag kind={variant} data-testid={`variant-${primary.id}`}>
              {group.variants[0]?.label ?? 'MTP'}
            </ModelTag>
          )}

          {quantOptions.length > 1 ? (
            <Select
              value={effectiveQuant}
              onValueChange={setQuant}
              onOpenChange={(open) => {
                if (open && entry.hfRepo !== undefined) loadLadder(entry.hfRepo);
              }}
            >
              <SelectTrigger
                className="h-7 min-w-[130px]"
                aria-label="Quantization"
                data-testid={`quant-${entry.id}`}
              />
              <SelectContent>
                {quantOptions.map((q) => (
                  <SelectItem key={q.quant} value={q.quant}>
                    {q.quant}
                    {q.bytes > 0 ? ` · ${formatBytes(q.bytes)}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <ModelTag kind="quant" icon={null} data-testid={`quant-${entry.id}`}>
              {effectiveQuant || '—'}
            </ModelTag>
          )}
        </div>

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
          ) : dl !== null ? null : downloaded ? (
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

      {/* Advanced (progressive disclosure): per-model default effort + the raw
          repo/variant/quant details behind the manager's Advanced toggle. */}
      {advanced ? (
        <div
          className="flex flex-col gap-3 border-t border-border-default pt-3"
          data-testid={`advanced-${primary.id}`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-caption text-text-secondary">Default effort</span>
            <EffortDefaultSelect modelId={primary.id} />
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-caption text-text-muted">
            {entry.hfRepo !== undefined ? (
              <>
                <dt>Repository</dt>
                <dd className="truncate font-mono text-text-secondary">{entry.hfRepo}</dd>
              </>
            ) : null}
            <dt>Speed variant</dt>
            <dd className="text-text-secondary">
              {group.variants.map((v) => v.label).join(' · ')}
            </dd>
            {group.variants.find((v) => v.method === variant)?.draftRepo !== undefined ? (
              <>
                <dt>Draft repo</dt>
                <dd className="truncate font-mono text-text-secondary">
                  {group.variants.find((v) => v.method === variant)?.draftRepo}
                </dd>
              </>
            ) : null}
            <dt>Quant</dt>
            <dd className="text-text-secondary">{effectiveQuant || '—'}</dd>
            <dt>Engine</dt>
            <dd className="text-text-secondary">
              {engineLabel(engine)}
              {engine === 'mlx' ? ' (non-GGUF model files)' : ''}
            </dd>
            <dt>Publisher</dt>
            <dd className="text-text-secondary">
              {primary.publisher?.handle ?? '—'}
              {reliable ? ' · reliable' : ''}
            </dd>
            <dt>Context window</dt>
            <dd className="text-text-secondary">{primary.contextWindow.toLocaleString()} tokens</dd>
            <dt>Vision / mmproj</dt>
            <dd className="text-text-secondary">{vision ? 'Supported' : 'Text-only'}</dd>
            <dt>Source</dt>
            <dd className="text-text-secondary">
              {entry.source === 'hf' ? 'Hugging Face (discovered)' : 'Curated catalog'}
              {entry.verified === false ? ' · checksum from repo tree' : ''}
              {entry.verified === true ? ' · HEAD-verified' : ''}
              {entry.sharded === true ? ' · multi-shard' : ''}
            </dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
