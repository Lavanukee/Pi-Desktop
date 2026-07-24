/**
 * Center viewport — empty state, the lazy three.js viewer, and the viewer
 * chrome: axis gizmo (kept BELOW menus — see tp-gizmo z-index), real topology
 * stats (written by the viewer), the floating right toolbar (lighting /
 * snapshot / grid / help / session task history), the four labeled render
 * modes (Clay · Textured · Normal · Wireframe), a minimal action pill
 * (turntable + Export), the REAL Export dialog (three.js exporters), and the
 * "View Your Model" coach dialog. No credits, promos, favorites, or share.
 */

import type { JSX, ReactNode } from 'react';
import { lazy, Suspense, useRef, useState } from 'react';
import { BlendGraph } from './BlendGraph';
import { EXPORT_FORMATS, type ExportFormat } from './data';
import { GenProgressCard } from './gen-ui';
import {
  IcCamera,
  IcCaretSmall,
  IcClose,
  IcDownload,
  IcFrame,
  IcHistory,
  IcMouse,
  IcPlanet,
  IcQuestion,
  IcSun,
  IcTrackpad,
} from './icons';
import { Hint, MenuAnchor, SliderRow, Toggle } from './primitives';
import { type TripoRenderMode, useTripoStore } from './store';
import { LogoMark } from './thumbs';
import { requestExport } from './viewer-io';

const Viewer3D = lazy(() => import('./Viewer3D'));

// ── axis gizmo ────────────────────────────────────────────────────────────
/** Static default orientation (matches the resting camera); the live viewer
 * repositions these elements every frame via data-ax/data-axline. */
const GIZMO_DEFAULT: Record<string, readonly [number, number]> = {
  x: [22, 9],
  y: [0, -25],
  z: [-19, 12],
  '-x': [-22, -9],
  '-y': [0, 25],
  '-z': [19, -12],
};

function Gizmo({
  gizmoRef,
}: {
  readonly gizmoRef: React.RefObject<HTMLDivElement | null>;
}): JSX.Element {
  return (
    <div className="tp-gizmo" ref={gizmoRef} data-testid="tp-gizmo" aria-hidden="true">
      <svg viewBox="0 0 76 76" className="tp-gizmo-lines" aria-hidden="true">
        {(['x', 'y', 'z'] as const).map((a) => {
          const p = GIZMO_DEFAULT[a] ?? [0, 0];
          return (
            <line
              key={a}
              data-axline={a}
              x1={38}
              y1={38}
              x2={38 + p[0]}
              y2={38 + p[1]}
              className={`tp-axline tp-axline-${a}`}
            />
          );
        })}
      </svg>
      {(['x', 'y', 'z', '-x', '-y', '-z'] as const).map((a) => {
        const p = GIZMO_DEFAULT[a] ?? [0, 0];
        const neg = a.startsWith('-');
        return (
          <span
            key={a}
            data-ax={a}
            className={`tp-axball tp-axball-${a.replace('-', 'n')} ${neg ? 'tp-axball-neg' : ''}`}
            style={{ transform: `translate(${p[0]}px, ${p[1]}px)` }}
          >
            {neg ? '' : a.toUpperCase()}
          </span>
        );
      })}
    </div>
  );
}

// ── floating right toolbar ────────────────────────────────────────────────
function FloatToolbar({ onSnapshot }: { readonly onSnapshot: () => void }): JSX.Element {
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const showGrid = useTripoStore((s) => s.showGrid);
  const envLight = useTripoStore((s) => s.envLight);
  const lightIntensity = useTripoStore((s) => s.lightIntensity);
  const history = useTripoStore((s) => s.history);
  const set = useTripoStore((s) => s.set);

  return (
    <div className="tp-float-tools">
      <div className="tp-float-group">
        <MenuAnchor
          id="lighting"
          placement="left-end"
          trigger={
            <Hint text="Lighting" side="left">
              <button
                type="button"
                className="tp-float-btn"
                data-testid="tp-light-btn"
                onClick={() => toggleMenu('lighting')}
              >
                <IcSun size={17} />
              </button>
            </Hint>
          }
          menu={
            <div className="tp-light-menu">
              <div className="tp-menu-heading">Lighting</div>
              <SliderRow
                label="Intensity"
                value={lightIntensity}
                display={`${lightIntensity}%`}
                min={0}
                max={100}
                onChange={(v) => set('lightIntensity', v)}
              />
              <div className="tp-field-row">
                <span className="tp-field-label">Environment light</span>
                <Toggle on={envLight} onChange={(v) => set('envLight', v)} />
              </div>
              <div className="tp-preset-row">
                {(
                  [
                    ['Studio', 60],
                    ['Soft', 35],
                    ['Night', 14],
                  ] as const
                ).map(([label, value]) => (
                  <button
                    key={label}
                    type="button"
                    className="tp-chip"
                    data-active={lightIntensity === value}
                    onClick={() => set('lightIntensity', value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          }
        />
        <span className="tp-float-sep" />
        <Hint text="Snapshot" side="left">
          <button
            type="button"
            className="tp-float-btn"
            data-testid="tp-snapshot-btn"
            onClick={onSnapshot}
          >
            <IcCamera size={17} />
          </button>
        </Hint>
        <span className="tp-float-sep" />
        <Hint text="Grid" side="left">
          <button
            type="button"
            className="tp-float-btn"
            data-active={showGrid}
            data-testid="tp-grid-btn"
            onClick={() => set('showGrid', !showGrid)}
          >
            <IcFrame size={17} />
          </button>
        </Hint>
      </div>

      <Hint text="Viewer help" side="left">
        <button
          type="button"
          className="tp-float-btn tp-float-solo"
          data-testid="tp-help-btn"
          onClick={() => set('modal', 'help')}
        >
          <IcQuestion size={17} />
        </button>
      </Hint>

      <MenuAnchor
        id="history"
        placement="left-end"
        trigger={
          <Hint text="Session tasks" side="left">
            <button
              type="button"
              className="tp-float-btn tp-float-solo"
              data-testid="tp-history-btn"
              onClick={() => toggleMenu('history')}
            >
              <IcHistory size={17} />
            </button>
          </Hint>
        }
        menu={
          <div className="tp-history-menu" data-testid="tp-history-menu">
            <div className="tp-menu-heading">Tasks this session</div>
            {history.length === 0 ? (
              <div className="tp-history-empty">No stages run yet</div>
            ) : (
              history.map((h) => (
                <div key={h.id} className="tp-history-row" data-state="done">
                  <div className="tp-history-main">
                    <span className="tp-history-label">{h.label}</span>
                    <span className="tp-history-sub">{h.sub}</span>
                  </div>
                  <span className="tp-history-state tp-history-done">Completed</span>
                </div>
              ))
            )}
          </div>
        }
      />
    </div>
  );
}

// ── render modes (Clay · Textured · Normal) + the Wireframe overlay toggle ─
const RENDER_MODES: readonly { id: TripoRenderMode; label: string }[] = [
  { id: 'clay', label: 'Clay' },
  { id: 'textured', label: 'Textured' },
  { id: 'normal', label: 'Normal' },
];

function RenderModeStrip(): JSX.Element {
  const renderMode = useTripoStore((s) => s.renderMode);
  const wireframe = useTripoStore((s) => s.wireframe);
  const set = useTripoStore((s) => s.set);

  return (
    <div className="tp-material-strip" data-testid="tp-render-modes">
      <div className="tp-strip-pill tp-mode-pill">
        {RENDER_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className="tp-mode-btn"
            data-active={renderMode === m.id}
            data-testid={`tp-rmode-${m.id}`}
            onClick={() => set('renderMode', m.id)}
          >
            {m.label}
          </button>
        ))}
        <span className="tp-strip-sep" />
        {/* Wireframe is an ON/OFF overlay drawn on top of the active mode. */}
        <button
          type="button"
          className="tp-mode-btn"
          data-active={wireframe}
          data-testid="tp-wire-toggle"
          onClick={() => set('wireframe', !wireframe)}
        >
          Wireframe
        </button>
      </div>
    </div>
  );
}

// ── bottom action pill: turntable + Export, nothing else ─────────────────
function ActionBar(): JSX.Element {
  const autoRotate = useTripoStore((s) => s.autoRotate);
  const set = useTripoStore((s) => s.set);

  return (
    <div className="tp-actionbar" data-testid="tp-actionbar">
      <Hint text="Turntable">
        <button
          type="button"
          className="tp-action-btn"
          data-active={autoRotate}
          data-testid="tp-turntable-btn"
          onClick={() => set('autoRotate', !autoRotate)}
        >
          <IcPlanet size={16} />
        </button>
      </Hint>
      <button
        type="button"
        className="tp-export-cta"
        data-testid="tp-export-pill-btn"
        onClick={() => set('modal', 'export')}
      >
        <IcDownload size={15} />
        Export
      </button>
    </div>
  );
}

// ── export dialog (REAL: three.js exporters via viewer-io) ───────────────
function ExportDialog(): JSX.Element {
  const set = useTripoStore((s) => s.set);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const assets = useTripoStore((s) => s.assets);
  const asset = assets.find((a) => a.id === loadedAssetId);
  const [name, setName] = useState(asset?.name ?? 'model');
  const [format, setFormat] = useState<ExportFormat>(EXPORT_FORMATS[0]);

  return (
    <div className="tp-export-dialog" data-testid="tp-export-dialog">
      <div className="tp-export-head">
        Export Model
        <button
          type="button"
          className="tp-iconbtn"
          aria-label="Close"
          data-testid="tp-export-close"
          onClick={() => set('modal', null)}
        >
          <IcClose size={15} />
        </button>
      </div>
      <label className="tp-export-field">
        <span className="tp-field-label">File name</span>
        <input
          type="text"
          className="tp-textinput"
          value={name}
          data-testid="tp-export-name"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="tp-field-row tp-field-row-wide">
        <span className="tp-field-label">Format</span>
        <MenuAnchor
          id="exportformat"
          placement="bottom-end"
          trigger={
            <button
              type="button"
              className="tp-select"
              data-testid="tp-select-exportformat"
              onClick={() => toggleMenu('exportformat')}
            >
              {format}
              <IcCaretSmall size={12} />
            </button>
          }
          menu={EXPORT_FORMATS.map((o) => (
            <button
              key={o}
              type="button"
              className="tp-menu-item"
              data-testid={`tp-format-${o}`}
              onClick={() => {
                setFormat(o);
                closeMenus();
              }}
            >
              <span className="tp-menu-item-label">{o}</span>
            </button>
          ))}
        />
      </div>
      <div className="tp-export-actions">
        <button
          type="button"
          className="tp-export-confirm"
          data-testid="tp-export-confirm"
          onClick={() => {
            // Real export: the viewer runs the matching three.js exporter and
            // saves the file via a download anchor.
            requestExport(format, name.trim().length > 0 ? name.trim() : 'model');
            set('modal', null);
          }}
        >
          <IcDownload size={14} />
          Export {format}
        </button>
      </div>
    </div>
  );
}

// ── "View Your Model" coach dialog ────────────────────────────────────────
function HelpTile({
  icon,
  label,
}: {
  readonly icon: ReactNode;
  readonly label: string;
}): JSX.Element {
  return (
    <div className="tp-help-tile">
      <span className="tp-help-tile-icon">{icon}</span>
      <span className="tp-help-tile-label">{label}</span>
    </div>
  );
}

function HelpModal(): JSX.Element {
  const set = useTripoStore((s) => s.set);
  return (
    <div className="tp-modal-backdrop" data-testid="tp-help-modal">
      <div className="tp-help-card">
        <div className="tp-help-head">
          View Your Model
          <button
            type="button"
            className="tp-iconbtn tp-help-close"
            aria-label="Close"
            data-testid="tp-help-close"
            onClick={() => set('modal', null)}
          >
            <IcClose size={15} />
          </button>
        </div>
        <div className="tp-help-section">
          <div className="tp-help-section-title">Rotate View</div>
          <div className="tp-help-tiles">
            <HelpTile icon={<IcMouse size={26} />} label="Left-Click & drag" />
            <HelpTile icon={<IcTrackpad size={26} />} label="Press & drag" />
          </div>
        </div>
        <div className="tp-help-section">
          <div className="tp-help-section-title">Pan View</div>
          <div className="tp-help-tiles">
            <HelpTile icon={<IcMouse size={26} />} label="Shift + Click & drag" />
            <HelpTile icon={<IcMouse size={26} />} label="Right-Click & drag" />
            <HelpTile icon={<IcTrackpad size={26} />} label="Two-finger press & drag" />
          </div>
        </div>
        <div className="tp-help-section">
          <div className="tp-help-section-title">Zoom in/out</div>
          <div className="tp-help-tiles">
            <HelpTile icon={<IcMouse size={26} />} label="Scroll wheel to zoom" />
            <HelpTile icon={<IcTrackpad size={26} />} label="Two-finger push forward" />
          </div>
        </div>
        <button
          type="button"
          className="tp-help-ok"
          data-testid="tp-help-ok"
          onClick={() => set('modal', null)}
        >
          OK
        </button>
      </div>
    </div>
  );
}

// ── the viewport ──────────────────────────────────────────────────────────
export function Viewport(): JSX.Element {
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const modal = useTripoStore((s) => s.modal);
  const pipelineStage = useTripoStore((s) => s.pipelineStage);
  const stats = useTripoStore((s) => s.stats);
  const tool = useTripoStore((s) => s.tool);
  const graphOpen = useTripoStore((s) => s.graphOpen);
  const gizmoRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(0);

  // The animation state machine editor takes over the whole viewport.
  const showGraph = tool === 'animate' && graphOpen;

  return (
    <div className="tp-viewport" data-testid="tp-viewport">
      {loadedAssetId !== null ? (
        <Suspense fallback={<div className="tp-canvas-loading">Preparing viewer…</div>}>
          <Viewer3D gizmoRef={gizmoRef} />
        </Suspense>
      ) : (
        <div className="tp-empty" data-testid="tp-empty-state">
          <LogoMark size={54} />
          <h1>Ready For A New 3D Model?</h1>
          <p>Generate from image or text — or drop a .glb/.obj/.stl anywhere</p>
        </div>
      )}

      {loadedAssetId !== null && stats !== null ? (
        <div className="tp-stats" data-testid="tp-stats" data-stage={pipelineStage}>
          <div className="tp-stat">
            <span>Topology</span>
            <strong>{stats.topology}</strong>
          </div>
          <div className="tp-stat">
            <span>Faces</span>
            <strong>{stats.faces.toLocaleString()}</strong>
          </div>
          <div className="tp-stat">
            <span>Vertices</span>
            <strong>{stats.vertices.toLocaleString()}</strong>
          </div>
        </div>
      ) : null}

      <Gizmo gizmoRef={gizmoRef} />
      <FloatToolbar onSnapshot={() => setFlash((f) => f + 1)} />
      {flash > 0 ? <div key={flash} className="tp-flash" /> : null}

      {loadedAssetId !== null ? (
        <>
          <RenderModeStrip />
          <ActionBar />
        </>
      ) : null}

      {/* Live engine-generation readout (staged chips + progress + message). */}
      <GenProgressCard />

      {/* The animation state machine editor overlays the whole viewport. */}
      {showGraph ? <BlendGraph /> : null}

      {modal === 'export' ? <ExportDialog /> : null}
      {modal === 'help' ? <HelpModal /> : null}
    </div>
  );
}
