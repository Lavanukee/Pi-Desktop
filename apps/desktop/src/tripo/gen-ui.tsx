/**
 * gen3d UI surfaces:
 *  - CapabilityLoop: a small, looping CSS/SVG animation that SHOWS what a model
 *    does (geometry materializing, an image resolving, texture wiping on, a
 *    mesh splitting into parts, tri-soup snapping to clean quads). Pure vector
 *    + keyframes — offline, theme-aware, no binary gifs.
 *  - DownloadPanel: the engine-model download experience as a FULL-HEIGHT left
 *    panel (not a cramped modal). Each model is a card: its capability loop, a
 *    plain-language line of what it unlocks, the real size, and its own Download
 *    button — plus one "Download all" at the foot. A model is never presented as
 *    usable before it's installed; this panel is the one way in.
 *  - GenProgressCard: the live generation readout in the viewport — staged
 *    pipeline chips (Image → Geometry → Texture), an overall bar, the engine's
 *    live message ("Geometry done — texturing (step 12/30)…"), the input-image
 *    thumbnail, and Cancel. Geometry lands in the viewer the moment it exists.
 */
import type { CSSProperties, JSX } from 'react';
import { useEffect, useRef } from 'react';
import type { Gen3dModelId, Gen3dRole } from '../../electron/gen3d/gen3d-contract';
import { formatGb, useGen3dStore } from './gen3d-client';
import { IcCaretSmall, IcCheck, IcClose, IcDownload } from './icons';

// ── capability loops (what each model does, animated) ─────────────────────

/** deterministic 0..1 pseudo-value (no Math.random — stable across renders). */
function pseudo(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function CapabilityLoop({ role }: { readonly role: Gen3dRole }): JSX.Element {
  if (role === 'geometry') {
    return (
      <svg className="cl cl-geo" viewBox="0 0 128 72" aria-hidden="true">
        <g className="cl-geo-model">
          {[0, 1, 2, 3, 4].map((i) => (
            <rect
              key={i}
              className="cl-geo-slice"
              x={44}
              y={18 + i * 8}
              width={40}
              height={6.5}
              rx={2}
              style={{ animationDelay: `${i * 0.16}s` } as CSSProperties}
            />
          ))}
        </g>
        <circle className="cl-geo-spark" cx={64} cy={12} r={2.4} />
      </svg>
    );
  }
  if (role === 'image') {
    const cells = Array.from({ length: 24 }, (_, i) => i);
    return (
      <svg className="cl cl-img" viewBox="0 0 128 72" aria-hidden="true">
        <rect className="cl-img-sky" x={36} y={14} width={56} height={30} rx={3} />
        <rect className="cl-img-ground" x={36} y={44} width={56} height={14} rx={3} />
        <circle className="cl-img-sun" cx={78} cy={25} r={6} />
        <path className="cl-img-hill" d="M36 44 L54 30 L70 44 Z" />
        <g className="cl-img-noise">
          {cells.map((i) => {
            const col = i % 6;
            const row = Math.floor(i / 6);
            return (
              <rect
                key={i}
                x={36 + col * 9.33}
                y={14 + row * 11}
                width={9.33}
                height={11}
                style={{ animationDelay: `${pseudo(i) * 1.1}s` } as CSSProperties}
              />
            );
          })}
        </g>
      </svg>
    );
  }
  if (role === 'texture') {
    return (
      <svg className="cl cl-tex" viewBox="0 0 128 72" aria-hidden="true">
        <defs>
          <linearGradient id="cl-tex-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f0b35a" />
            <stop offset="0.5" stopColor="#e0705a" />
            <stop offset="1" stopColor="#6f7ce0" />
          </linearGradient>
          <clipPath id="cl-tex-clip">
            <circle cx={64} cy={37} r={20} />
          </clipPath>
        </defs>
        <circle className="cl-tex-base" cx={64} cy={37} r={20} />
        <g clipPath="url(#cl-tex-clip)">
          <rect
            className="cl-tex-color"
            x={44}
            y={17}
            width={40}
            height={40}
            fill="url(#cl-tex-grad)"
          />
        </g>
        <circle className="cl-tex-brush" cx={44} cy={37} r={3} />
      </svg>
    );
  }
  if (role === 'segment') {
    return (
      <svg className="cl cl-seg" viewBox="0 0 128 72" aria-hidden="true">
        <rect className="cl-seg-a" x={48} y={14} width={32} height={13} rx={4} />
        <rect className="cl-seg-b" x={48} y={30} width={32} height={13} rx={4} />
        <rect className="cl-seg-c" x={48} y={46} width={32} height={13} rx={4} />
      </svg>
    );
  }
  // retopo
  const h = [22, 30, 38, 46, 54];
  const v = [46, 56, 66, 76, 86];
  return (
    <svg className="cl cl-retopo" viewBox="0 0 128 72" aria-hidden="true">
      <g className="cl-retopo-tri">
        <path d="M44 22 L88 22 L44 58 L88 58 M44 40 L88 22 M44 58 L74 22 M60 22 L88 58" />
      </g>
      <g className="cl-retopo-quad">
        {h.map((y) => (
          <line key={`h${y}`} x1={44} y1={y} x2={88} y2={y} />
        ))}
        {v.map((x) => (
          <line key={`v${x}`} x1={x} y1={22} x2={x} y2={54} />
        ))}
      </g>
    </svg>
  );
}

// ── download panel ─────────────────────────────────────────────────────────

const ROLE_LABEL: Record<Gen3dRole, string> = {
  geometry: 'Generation',
  image: 'Text → image',
  texture: 'Texturing',
  segment: 'Segmentation',
  retopo: 'Retopology',
};

/** Plain-language "what this unlocks" line per role — the headline the user
 * actually cares about (the repo attribution stays as the small print). */
const ROLE_BLURB: Record<Gen3dRole, string> = {
  geometry: 'Turn an image or a text prompt into a full 3D model.',
  image: 'Generate images from text — the first hop of text → 3D.',
  texture: 'Generate PBR textures and paint them onto a model.',
  segment: 'Split a model into clean, named semantic parts.',
  retopo: 'Rebuild a messy mesh as clean, animation-ready quad topology.',
};

function ModelCard({ id }: { readonly id: Gen3dModelId }): JSX.Element | null {
  const model = useGen3dStore((s) => s.models.find((m) => m.id === id));
  const dl = useGen3dStore((s) => s.downloads[id]);
  const focus = useGen3dStore((s) => s.downloadFocus === id);
  const download = useGen3dStore((s) => s.download);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus]);

  if (model === undefined) return null;
  const inFlight = dl !== undefined && !dl.done && dl.error === undefined;
  const pct =
    inFlight && dl.totalBytes > 0 ? Math.round((dl.receivedBytes / dl.totalBytes) * 100) : null;

  return (
    <div
      ref={ref}
      className="tp-dlcard"
      data-focus={focus}
      data-installed={model.installed}
      data-testid={`tp-dlcard-${id}`}
    >
      <div className="tp-dlcard-loop">
        <CapabilityLoop role={model.role} />
      </div>
      <div className="tp-dlcard-body">
        <div className="tp-dlcard-titles">
          <span className="tp-dlcard-name">{model.label}</span>
          <em className="tp-dlcard-role">{ROLE_LABEL[model.role]}</em>
        </div>
        <p className="tp-dlcard-blurb">{ROLE_BLURB[model.role]}</p>
        <p className="tp-dlcard-note">{model.note}</p>
        <div className="tp-dlcard-foot">
          {model.installed ? (
            <span className="tp-dlcard-installed">
              <IcCheck size={13} /> Installed
            </span>
          ) : inFlight ? (
            <div className="tp-progress tp-dlcard-progress">
              <div className="tp-progress-bar" style={{ width: `${pct ?? 2}%` }} />
              <span className="tp-progress-num">{pct === null ? '…' : `${pct}%`}</span>
            </div>
          ) : (
            <button
              type="button"
              className="tp-dlcard-btn"
              data-testid={`tp-download-${id}`}
              onClick={() => void download([id])}
            >
              <IcDownload size={14} />
              Download · {formatGb(model.sizeBytes)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function DownloadPanel(): JSX.Element {
  const models = useGen3dStore((s) => s.models);
  const downloads = useGen3dStore((s) => s.downloads);
  const setOpen = useGen3dStore((s) => s.setDownloadPromptOpen);
  const download = useGen3dStore((s) => s.download);

  const missing = models.filter((m) => !m.installed);
  const totalBytes = missing.reduce((a, m) => a + m.sizeBytes, 0);
  const anyDownloading =
    models.some((m) => m.downloading) ||
    Object.values(downloads).some((d) => !d.done && d.error === undefined);

  return (
    <section className="tp-dlpanel" data-testid="tp-download-panel">
      <div className="tp-dlpanel-head">
        <button
          type="button"
          className="tp-dlpanel-back"
          data-testid="tp-download-back"
          onClick={() => setOpen(false)}
        >
          <IcCaretSmall size={16} className="tp-back-caret" />
          Back
        </button>
        <span className="tp-dlpanel-title">3D engine models</span>
        <button
          type="button"
          className="tp-iconbtn"
          aria-label="Close"
          data-testid="tp-download-close"
          onClick={() => setOpen(false)}
        >
          <IcClose size={15} />
        </button>
      </div>
      <p className="tp-dlpanel-blurb">
        Everything runs locally on this Mac after download. Grab just what a stage needs, or the
        whole engine.
      </p>
      <div className="tp-dlpanel-scroll">
        {models.map((m) => (
          <ModelCard key={m.id} id={m.id} />
        ))}
      </div>
      <div className="tp-dlpanel-foot">
        <button
          type="button"
          className="tp-generate-btn"
          data-testid="tp-download-all"
          disabled={missing.length === 0 || anyDownloading}
          onClick={() => void download(missing.map((m) => m.id))}
        >
          <IcDownload size={15} />
          {missing.length === 0 ? 'All models installed' : `Download all · ${formatGb(totalBytes)}`}
        </button>
      </div>
    </section>
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
