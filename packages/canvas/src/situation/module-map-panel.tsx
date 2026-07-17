/**
 * The file/module map — the project skeleton filling in as the build lands
 * files (spec §11). Two presentations, gated by the app's userMode:
 *
 *  - `power`: raw file truth. Chips carry the filename plus LIVE cumulative
 *    +/− line deltas (green/red, flashing as chunks land); a file being edited
 *    RIGHT NOW lights up; new files fade in at the front; a card whose area is
 *    hot carries the branded corner spinner; long file lists stay contained
 *    behind a "+N more" reveal so the map never overflows.
 *
 *  - `user`: no raw paths. Each area reads as a named card with its purpose,
 *    an honest progress hairline (from task state), and an abstract row of
 *    "pages" — one per file written, the hot one glowing — so the sense of
 *    files-being-written survives without filenames.
 */

import { useEffect, useState } from 'react';
import type { FileTouchView, ModuleRegionFill } from './situation-model.ts';

/** Per-area task progress, keyed by area name (checklist group). */
export type AreaProgress = Readonly<Record<string, { done: number; total: number }>>;

export interface ModuleMapPanelProps {
  regions: readonly ModuleRegionFill[];
  /** `power` shows file paths + deltas; `user` shows the abstract area view. */
  variant?: 'user' | 'power';
  /** Task progress per area (drives the user-variant progress hairline). */
  progress?: AreaProgress;
}

/** Chips visible per card before the "+N more" reveal (keeps cards contained). */
const COLLAPSED_FILE_LIMIT = 6;
/** Abstract pages shown per user-variant card before the "+N" tail. */
const PAGE_LIMIT = 18;

export function ModuleMapPanel({ regions, variant = 'power', progress }: ModuleMapPanelProps) {
  if (regions.length === 0) {
    return (
      <div className="pd-sitroom-map" data-empty>
        <span className="pd-sitroom-map-empty">The project layout is still being drawn…</span>
      </div>
    );
  }
  return (
    <ul className="pd-sitroom-map pd-scroll" aria-label="Where the files are landing">
      {regions.map((region) => {
        const live = region.files.some((f) => f.active);
        return variant === 'power' ? (
          <PowerRegionCard key={region.path} region={region} live={live} />
        ) : (
          <AreaCard
            key={region.path}
            region={region}
            live={live}
            progress={progress?.[region.owner]}
          />
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Power variant: the raw file map
// ---------------------------------------------------------------------------

function PowerRegionCard({ region, live }: { region: ModuleRegionFill; live: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // Newest-first: fresh files fade in AT THE FRONT, so the live edge of the
  // build is always visible even while the list is collapsed.
  const files = [...region.files].reverse();
  const hidden = files.length - COLLAPSED_FILE_LIMIT;
  const shown = expanded ? files : files.slice(0, COLLAPSED_FILE_LIMIT);
  return (
    <li className="pd-sitroom-region" data-live={live || undefined}>
      <div className="pd-sitroom-region-head">
        <span className="pd-sitroom-region-path">{region.path}</span>
        <span className="pd-sitroom-region-owner">{region.owner}</span>
        {live ? <span className="pd-sitroom-region-spin" aria-hidden="true" /> : null}
      </div>
      {files.length > 0 ? (
        <div
          className={`pd-sitroom-region-files${expanded ? ' pd-scroll' : ''}`}
          data-expanded={expanded || undefined}
        >
          {shown.map((file) => (
            <FileChip key={file.path} file={file} regionPath={region.path} />
          ))}
          {hidden > 0 ? (
            <button
              type="button"
              className="pd-sitroom-region-more pd-focusable"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'less' : `+${hidden} more`}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="pd-sitroom-region-blank">{region.purpose ?? 'waiting for work'}</div>
      )}
    </li>
  );
}

/** How long a landed file stays "fresh" (sheen) after a touch. */
const FRESH_MS = 1700;

function FileChip({ file, regionPath }: { file: FileTouchView; regionPath: string }) {
  const name = file.path.startsWith(regionPath) ? file.path.slice(regionPath.length) : file.path;
  const [fresh, setFresh] = useState(() => Date.now() - file.lastTouch < FRESH_MS);

  // Re-flash on every subsequent touch of the same file; settle afterwards.
  useEffect(() => {
    const age = Date.now() - file.lastTouch;
    if (age >= FRESH_MS) {
      setFresh(false);
      return undefined;
    }
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), FRESH_MS - age);
    return () => clearTimeout(timer);
  }, [file.lastTouch]);

  const hasDelta = file.added > 0 || file.removed > 0;
  return (
    <span
      className="pd-sitroom-file"
      data-fresh={fresh || undefined}
      data-active={file.active || undefined}
      title={`${file.path}${hasDelta ? ` · +${file.added} −${file.removed}` : ''}`}
    >
      <span className="pd-sitroom-file-name">{name}</span>
      {hasDelta ? (
        // Keyed by touches so each landing chunk re-pops the delta readout.
        <span className="pd-sitroom-file-delta" key={file.touches}>
          {file.added > 0 ? <em data-tone="add">+{file.added}</em> : null}
          {file.removed > 0 ? <em data-tone="del">−{file.removed}</em> : null}
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// User variant: areas + progress, files as abstract pages (no raw paths)
// ---------------------------------------------------------------------------

function AreaCard({
  region,
  live,
  progress,
}: {
  region: ModuleRegionFill;
  live: boolean;
  progress?: { done: number; total: number };
}) {
  const written = region.files.length;
  const pages = region.files.slice(-PAGE_LIMIT);
  const overflow = written - pages.length;
  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : undefined;
  return (
    <li className="pd-sitroom-region pd-sitroom-region--area" data-live={live || undefined}>
      <div className="pd-sitroom-region-head">
        <span className="pd-sitroom-area-name">{region.owner}</span>
        <span className="pd-sitroom-area-count">
          {written > 0 ? `${written} ${written === 1 ? 'file' : 'files'}` : ''}
        </span>
        {live ? <span className="pd-sitroom-region-spin" aria-hidden="true" /> : null}
      </div>
      {region.purpose !== undefined ? (
        <div className="pd-sitroom-area-purpose">{region.purpose}</div>
      ) : null}
      {progress && progress.total > 0 ? (
        <span
          className="pd-sitroom-area-track"
          role="progressbar"
          aria-valuenow={progress.done}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-label={`${region.owner} progress`}
        >
          <span className="pd-sitroom-area-fill" style={{ width: `${pct}%` }} />
        </span>
      ) : null}
      {written > 0 ? (
        <div className="pd-sitroom-area-pages" role="img" aria-label={`${written} files written`}>
          {pages.map((file) => (
            <span
              key={file.path}
              className="pd-sitroom-page"
              data-active={file.active || undefined}
            />
          ))}
          {overflow > 0 ? <span className="pd-sitroom-area-overflow">+{overflow}</span> : null}
        </div>
      ) : (
        <div className="pd-sitroom-region-blank">getting ready…</div>
      )}
    </li>
  );
}
