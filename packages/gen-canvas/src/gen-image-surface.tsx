/**
 * GenImageSurface — the generation IMAGE canvas surface: a candidate grid, a live
 * progress bar while denoising, and the model-name FOOTNOTE stamped on every
 * output (round-13 requirement — provenance on everything the generator makes).
 *
 * The component is a pure renderer of {@link GenImageSurfaceData}; the app feeds
 * it live data as a gen job streams (pending → generating with step previews →
 * done). It is registered ADDITIVELY on the canvas surface registry (see
 * ./register.ts) under a distinct `gen-image` kind, so it never rewrites the
 * canvas core or collides with the built-in single-image media surface.
 */
import { Spinner } from '@pi-desktop/ui';

export type GenCandidateStatus = 'pending' | 'generating' | 'done' | 'error';

export interface GenCandidate {
  readonly seed?: number;
  /** Live step-preview src (the running composite) while generating. */
  readonly previewSrc?: string;
  /** Final image src once the candidate is done. */
  readonly finalSrc?: string;
  readonly status: GenCandidateStatus;
}

export interface GenModelInfo {
  readonly id: string;
  readonly label: string;
  readonly license: string;
}

export interface GenImageSurfaceData {
  readonly model: GenModelInfo;
  readonly prompt?: string;
  readonly candidates: readonly GenCandidate[];
  /** Live denoising progress for the active candidate. */
  readonly progress?: { readonly candidate: number; readonly step: number; readonly total: number };
  readonly status: 'generating' | 'done' | 'error';
  readonly error?: string;
}

/** The FOOTNOTE stamped on every output: model label, id, and license. */
export function modelFootnote(model: GenModelInfo): string {
  return `${model.label} · ${model.id} · ${model.license}`;
}

function progressRatio(data: GenImageSurfaceData): number {
  if (data.status === 'done') return 1;
  const p = data.progress;
  if (p === undefined || p.total <= 0) return 0;
  // Fold the per-candidate step progress into overall progress across candidates.
  const per = 1 / Math.max(1, data.candidates.length);
  return Math.min(1, per * (p.candidate + p.step / p.total));
}

export interface GenImageSurfaceProps {
  data: GenImageSurfaceData;
}

/** One candidate cell: the image (final or live preview) + a per-image footnote. */
function CandidateCell({
  candidate,
  model,
  index,
}: {
  candidate: GenCandidate;
  model: GenModelInfo;
  index: number;
}) {
  const src = candidate.finalSrc ?? candidate.previewSrc;
  const seedLabel = candidate.seed !== undefined ? `seed ${candidate.seed}` : `#${index + 1}`;
  return (
    <figure className="pd-gen-cell" data-status={candidate.status}>
      <div className="pd-gen-cell-media">
        {src !== undefined ? (
          <img
            className="pd-gen-cell-img"
            src={src}
            alt={`Candidate ${index + 1} (${seedLabel})`}
            data-live={candidate.finalSrc === undefined ? 'true' : 'false'}
          />
        ) : (
          <div className="pd-gen-cell-placeholder">
            <Spinner size={20} />
          </div>
        )}
        {candidate.status === 'generating' ? (
          <div className="pd-gen-cell-badge">generating…</div>
        ) : null}
      </div>
      {/* Per-output FOOTNOTE — model provenance on every image. */}
      <figcaption className="pd-gen-cell-footnote">
        {seedLabel} · {modelFootnote(model)}
      </figcaption>
    </figure>
  );
}

export function GenImageSurface({ data }: GenImageSurfaceProps) {
  const ratio = progressRatio(data);
  const pct = Math.round(ratio * 100);
  const generating = data.status === 'generating';

  return (
    <div className="pd-gen" data-status={data.status}>
      {data.prompt !== undefined ? (
        <p className="pd-gen-prompt" title={data.prompt}>
          {data.prompt}
        </p>
      ) : null}

      {generating ? (
        <div
          className="pd-gen-progress"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="pd-gen-progress-bar" style={{ width: `${pct}%` }} />
          <span className="pd-gen-progress-label">
            {data.progress !== undefined
              ? `Candidate ${data.progress.candidate + 1}/${data.candidates.length} · step ${data.progress.step}/${data.progress.total}`
              : 'Starting…'}
          </span>
        </div>
      ) : null}

      {data.status === 'error' ? (
        <div className="pd-gen-error" role="alert">
          {data.error ?? 'Generation failed'}
        </div>
      ) : null}

      <div className="pd-gen-grid" data-count={data.candidates.length}>
        {data.candidates.map((candidate, i) => (
          <CandidateCell
            key={candidate.seed ?? i}
            candidate={candidate}
            model={data.model}
            index={i}
          />
        ))}
      </div>

      {/* Footer FOOTNOTE — the model that produced this surface. */}
      <footer className="pd-gen-footer">Made with {modelFootnote(data.model)}</footer>
    </div>
  );
}
