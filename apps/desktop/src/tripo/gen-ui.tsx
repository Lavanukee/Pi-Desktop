/**
 * gen3d UI surfaces:
 *  - Gen3dDownloadDialog: the engine-model download prompt. Lists every model
 *    with its REAL size (n.n GB), per-row live progress while downloading, and
 *    a "Download all" total — the user always knows exactly what they're
 *    pulling before anything starts.
 *  - GenProgressCard: the live generation readout in the viewport — staged
 *    pipeline chips (Image → Geometry → Texture), an overall progress bar, the
 *    engine's live message ("Geometry done — texturing (step 12/30)…"), the
 *    input-image thumbnail when one exists, and Cancel. Generated geometry
 *    lands in the viewer the moment it exists (gen3d-client ingests model-glb
 *    artifacts); this card narrates the rest.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import type { Gen3dModelId, Gen3dRole } from '../../electron/gen3d/gen3d-contract';
import { formatGb, useGen3dStore } from './gen3d-client';
import { IcClose, IcDownload } from './icons';

// ── download prompt ───────────────────────────────────────────────────────

const ROLE_LABEL: Record<Gen3dRole, string> = {
  geometry: 'Generation',
  image: 'Text → image',
  texture: 'Texturing',
  segment: 'Segmentation',
  retopo: 'Retopology',
};

export function Gen3dDownloadDialog(): JSX.Element | null {
  const open = useGen3dStore((s) => s.downloadPromptOpen);
  const models = useGen3dStore((s) => s.models);
  const downloads = useGen3dStore((s) => s.downloads);
  const setOpen = useGen3dStore((s) => s.setDownloadPromptOpen);
  const download = useGen3dStore((s) => s.download);
  const [checked, setChecked] = useState<readonly Gen3dModelId[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const missing = models.filter((m) => !m.installed);
  const selected = checked ?? missing.map((m) => m.id);
  const selectedModels = models.filter((m) => selected.includes(m.id) && !m.installed);
  const totalBytes = selectedModels.reduce((a, m) => a + m.sizeBytes, 0);
  const anyDownloading =
    models.some((m) => m.downloading) ||
    Object.values(downloads).some((d) => !d.done && d.error === undefined);

  const toggle = (id: Gen3dModelId) => {
    setChecked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <div className="tp-modal-backdrop" data-testid="tp-gen3d-download-dialog">
      <div className="tp-download-card">
        <div className="tp-export-head">
          Download 3D engine models
          <button
            type="button"
            className="tp-iconbtn"
            aria-label="Close"
            data-testid="tp-gen3d-download-close"
            onClick={() => setOpen(false)}
          >
            <IcClose size={15} />
          </button>
        </div>
        <p className="tp-download-blurb">
          Everything runs locally after download. Sizes are the real download totals — pick what you
          need or grab it all.
        </p>
        <div className="tp-download-rows">
          {models.map((m) => {
            const dl = downloads[m.id];
            const inFlight = dl !== undefined && !dl.done && dl.error === undefined;
            const pct =
              inFlight && dl.totalBytes > 0
                ? Math.round((dl.receivedBytes / dl.totalBytes) * 100)
                : null;
            return (
              <div className="tp-download-row" key={m.id} data-testid={`tp-gen3d-row-${m.id}`}>
                <label className="tp-download-main">
                  <input
                    type="checkbox"
                    checked={m.installed || selected.includes(m.id)}
                    disabled={m.installed || inFlight}
                    onChange={() => toggle(m.id)}
                  />
                  <span className="tp-download-titles">
                    <span className="tp-download-name">
                      {m.label}
                      <em className="tp-download-role">{ROLE_LABEL[m.role]}</em>
                    </span>
                    <span className="tp-download-note">{m.note}</span>
                  </span>
                </label>
                <span className="tp-download-size" data-testid={`tp-gen3d-size-${m.id}`}>
                  {m.installed ? 'Installed' : formatGb(m.sizeBytes)}
                </span>
                {inFlight ? (
                  <div className="tp-progress tp-download-progress">
                    <div className="tp-progress-bar" style={{ width: `${pct ?? 2}%` }} />
                    <span className="tp-progress-num">{pct === null ? '…' : `${pct}%`}</span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {error !== null ? <div className="tp-download-error">{error}</div> : null}
        <div className="tp-export-actions">
          <button
            type="button"
            className="tp-export-confirm"
            data-testid="tp-gen3d-download-all"
            disabled={selectedModels.length === 0 || anyDownloading}
            onClick={() => {
              setError(null);
              void download(selectedModels.map((m) => m.id)).then((err) => {
                if (err !== null) setError(err);
              });
            }}
          >
            <IcDownload size={14} />
            {selectedModels.length === missing.length
              ? `Download all (${formatGb(totalBytes)})`
              : `Download selected (${formatGb(totalBytes)})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── live generation progress ──────────────────────────────────────────────

const STAGE_CHIP: Record<Gen3dRole, string> = {
  image: 'Image',
  geometry: 'Geometry',
  texture: 'Texture',
  segment: 'Segment',
  retopo: 'Retopo',
};

/** The chips shown for a job: the full generate pipeline shows its chain; a
 * single stage op shows just itself. */
function chipsFor(stage: Gen3dRole): readonly Gen3dRole[] {
  if (stage === 'segment' || stage === 'retopo') return [stage];
  return ['image', 'geometry', 'texture'];
}

export function GenProgressCard(): JSX.Element | null {
  const job = useGen3dStore((s) => s.job);
  const cancelJob = useGen3dStore((s) => s.cancelJob);
  const clearJob = useGen3dStore((s) => s.clearJob);
  if (job === null) return null;

  const chips = chipsFor(job.stage);
  const activeIdx = chips.indexOf(job.stage);
  const failed = job.error !== undefined;

  return (
    <div className="tp-genprogress" data-testid="tp-genprogress" data-done={job.done}>
      <div className="tp-genprogress-head">
        <div className="tp-genprogress-chips">
          {chips.map((c, i) => (
            <span
              key={c}
              className="tp-genprogress-chip"
              data-state={i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'todo'}
            >
              {STAGE_CHIP[c]}
            </span>
          ))}
        </div>
        {job.done ? (
          <button
            type="button"
            className="tp-iconbtn"
            aria-label="Dismiss"
            data-testid="tp-genprogress-dismiss"
            onClick={clearJob}
          >
            <IcClose size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="tp-linklike"
            data-testid="tp-genprogress-cancel"
            onClick={() => void cancelJob()}
          >
            Cancel
          </button>
        )}
      </div>
      {failed ? (
        <div className="tp-genprogress-error" data-testid="tp-genprogress-error">
          {job.error}
        </div>
      ) : (
        <>
          <div className="tp-progress tp-genprogress-bar">
            <div className="tp-progress-bar" style={{ width: `${job.overallPercent}%` }} />
            <span className="tp-progress-num">{Math.round(job.overallPercent)}%</span>
          </div>
          <div className="tp-genprogress-msg" data-testid="tp-genprogress-msg">
            {job.message}
          </div>
        </>
      )}
      {job.artifact?.kind === 'image' ? (
        <img
          className="tp-genprogress-thumb"
          src={`pd-file://f${job.artifact.path.split('/').map(encodeURIComponent).join('/')}`}
          alt={job.artifact.label}
        />
      ) : null}
    </div>
  );
}
