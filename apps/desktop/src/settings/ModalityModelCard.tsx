/**
 * One generation-model card in the model browser's modality category grids
 * (Image / Video / Audio / Music / 3D). The lightweight twin of {@link ModelCard}:
 * these backends are not yet installable in-app (Phase 0 surfaces the vetted
 * catalog; the gen backends land in later phases), so the card is informational —
 * it renders the label, the RECOMMENDED sparkle, the MODALITY pill, the GATED
 * lock for `commercialUse:false` rows, size / license, and a unified-memory-fit
 * badge (reusing the LLM store's detected hardware + the shared RAM verdict).
 */
import { Badge, IconSpeed } from '@pi-desktop/ui';
import type { ModalityCatalogEntry } from '../../electron/gen/gen-ipc-contract';
import { useLlmStore } from '../state/llm-store';
import {
  categoryOf,
  formatApproxSize,
  MODALITY_SPEED_LABEL,
  modalityRequiresGate,
  modalitySpeed,
} from './modality-catalog-logic';
import { ramVerdict } from './model-manager-logic';
import { ModalityPill, ModelTag } from './model-tags';

export function ModalityModelCard({
  entry,
  advanced = false,
}: {
  entry: ModalityCatalogEntry;
  /** Reveal the repo id + notes behind the manager's Advanced toggle. */
  advanced?: boolean;
}) {
  const hardware = useLlmStore((s) => s.hardware);
  const category = categoryOf(entry);
  const gated = modalityRequiresGate(entry);
  const minMem = entry.minUnifiedMemoryGB ?? 0;
  const ram = ramVerdict(minMem, hardware?.totalRamGB ?? 0);
  const speed = modalitySpeed(entry);

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border-default bg-bg-raised p-4"
      data-testid={`modality-card-${entry.id}`}
      data-recommended={entry.recommended ? 'true' : 'false'}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-body font-medium text-text-primary">{entry.label}</span>
            {entry.recommended ? (
              <ModelTag kind="recommended" data-testid={`recommended-badge-${entry.id}`}>
                Recommended
              </ModelTag>
            ) : null}
            <ModalityPill category={category} data-testid={`modality-badge-${entry.id}`} />
            {/* Little speed card: speedometer + a fast/balanced/slow word derived
                from the model's weight/heaviness (mirrors the LLM tierSpeed). */}
            <ModelTag
              kind="neutral"
              icon={<IconSpeed size={12} />}
              title="Rough generation speed on this Mac"
              data-testid={`modality-speed-${entry.id}`}
            >
              {MODALITY_SPEED_LABEL[speed]}
            </ModelTag>
            {gated ? (
              <ModelTag kind="gated" data-testid={`gated-badge-${entry.id}`}>
                Gated
              </ModelTag>
            ) : null}
            {entry.reserved ? (
              <ModelTag kind="neutral" icon={null} title="Backend arrives in a later update">
                Preview
              </ModelTag>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-muted">
            <ModelTag kind="size" icon={null}>
              {formatApproxSize(entry.approxSizeGB)}
            </ModelTag>
            <span>·</span>
            <span>{entry.license}</span>
            {!entry.runsLocally ? (
              <>
                <span>·</span>
                <span title="Runs on a remote GPU, not on this Mac">remote-only</span>
              </>
            ) : null}
          </div>
        </div>
        {minMem > 0 ? (
          <Badge tone={ram.tone} size="sm" data-testid={`modality-ram-${entry.id}`}>
            {ram.label}
          </Badge>
        ) : null}
      </div>

      {advanced ? (
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-border-default pt-3 text-caption text-text-muted"
          data-testid={`modality-advanced-${entry.id}`}
        >
          {entry.repo !== undefined ? (
            <>
              <dt>Repository</dt>
              <dd className="truncate font-mono text-text-secondary">{entry.repo}</dd>
            </>
          ) : null}
          <dt>Backend</dt>
          <dd className="text-text-secondary">{entry.backend}</dd>
          {minMem > 0 ? (
            <>
              <dt>Min memory</dt>
              <dd className="text-text-secondary">{minMem} GB unified</dd>
            </>
          ) : null}
          {entry.notes !== undefined ? (
            <>
              <dt>Notes</dt>
              <dd className="text-text-secondary">{entry.notes}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
