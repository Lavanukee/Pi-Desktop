/**
 * Center viewport — empty state ("Ready For A New 3D Model?"), the lazy
 * three.js viewer once an asset is loaded, and ALL the viewer chrome from the
 * reference: axis gizmo, topology stats, floating right toolbar (lighting
 * popover / screenshot flash / grid toggle / help / history), the material +
 * render-mode strip, the bottom action pill (undo/redo/gift/turntable/3D
 * Print/star/share/Export), the Export dialog with its Send To menu, and the
 * "View Your Model" coach dialog.
 */

import type { JSX, ReactNode } from 'react';
import { lazy, Suspense, useRef, useState } from 'react';
import {
  EXPORT_FORMATS,
  EXPORT_QUALITY,
  HISTORY_ROWS,
  SEND_TO_TARGETS,
  TRIPO_ASSETS,
} from './data';
import {
  IcBolt,
  IcCamera,
  IcCaretSmall,
  IcClose,
  IcDownload,
  IcFrame,
  IcGift,
  IcGlobe,
  IcHistory,
  IcMouse,
  IcPlanet,
  IcPrinter,
  IcQuestion,
  IcRedo,
  IcShare,
  IcSliders,
  IcStar,
  IcSun,
  IcTrackpad,
  IcUndo,
} from './icons';
import { Hint, MenuAnchor, SliderRow, Toggle } from './primitives';
import { type TripoRenderMode, useTripoStore } from './store';
import { AssetThumb, LogoMark } from './thumbs';

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
          <Hint text="Task history" side="left">
            <button
              type="button"
              className="tp-float-btn tp-float-solo"
              data-testid="tp-history-btn"
              onClick={() => toggleMenu('history')}
            >
              <IcHistory size={17} />
              <span className="tp-reddot" />
            </button>
          </Hint>
        }
        menu={
          <div className="tp-history-menu" data-testid="tp-history-menu">
            <div className="tp-menu-heading">Tasks</div>
            {HISTORY_ROWS.map((h) => (
              <div key={h.id} className="tp-history-row" data-state={h.state}>
                <div className="tp-history-main">
                  <span className="tp-history-label">{h.label}</span>
                  <span className="tp-history-sub">{h.sub}</span>
                </div>
                {h.state === 'running' ? (
                  <div className="tp-progress">
                    <div className="tp-progress-bar" style={{ width: `${h.progress ?? 0}%` }} />
                    <span className="tp-progress-num">{h.progress}%</span>
                  </div>
                ) : (
                  <span className={`tp-history-state tp-history-${h.state}`}>
                    {h.state === 'done' ? 'Completed' : 'In queue'}
                  </span>
                )}
              </div>
            ))}
          </div>
        }
      />
    </div>
  );
}

// ── material / render-mode strip ──────────────────────────────────────────
const RENDER_MODES: readonly { id: TripoRenderMode; cls: string; hint: string }[] = [
  { id: 'clay', cls: 'tp-sphere-clay', hint: 'Clay' },
  { id: 'shaded', cls: 'tp-sphere-shaded', hint: 'Shaded' },
  { id: 'normal', cls: 'tp-sphere-normal', hint: 'Normal' },
];
const MATERIAL_SPHERES = [
  { id: 'matte', cls: 'tp-sphere-matte', hint: 'Matte' },
  { id: 'gold', cls: 'tp-sphere-gold', hint: 'Gold' },
  { id: 'chrome', cls: 'tp-sphere-chrome', hint: 'Chrome' },
  { id: 'teal', cls: 'tp-sphere-teal', hint: 'Teal' },
] as const;

function MaterialStrip(): JSX.Element {
  const renderMode = useTripoStore((s) => s.renderMode);
  const material = useTripoStore((s) => s.material);
  const envLight = useTripoStore((s) => s.envLight);
  const wireframe = useTripoStore((s) => s.wireframe);
  const autoRotate = useTripoStore((s) => s.autoRotate);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const set = useTripoStore((s) => s.set);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const asset = TRIPO_ASSETS.find((a) => a.id === loadedAssetId);

  return (
    <div className="tp-material-strip" data-testid="tp-material-strip">
      {asset !== undefined ? (
        <Hint text="Source preview">
          <button type="button" className="tp-source-thumb">
            <AssetThumb art={asset.art} />
          </button>
        </Hint>
      ) : null}
      <div className="tp-strip-pill">
        <Hint text="Environment">
          <button
            type="button"
            className="tp-strip-btn"
            data-active={envLight}
            onClick={() => set('envLight', !envLight)}
          >
            <IcGlobe size={15} />
          </button>
        </Hint>
        <span className="tp-strip-sep" />
        {RENDER_MODES.map((m) => (
          <Hint key={m.id} text={m.hint}>
            <button
              type="button"
              className="tp-strip-btn"
              data-active={renderMode === m.id}
              data-testid={`tp-rmode-${m.id}`}
              onClick={() => set('renderMode', m.id)}
            >
              <span className={`tp-sphere ${m.cls}`} />
            </button>
          </Hint>
        ))}
        <MenuAnchor
          id="display"
          placement="top-start"
          trigger={
            <Hint text="Display settings">
              <button
                type="button"
                className="tp-strip-btn"
                data-testid="tp-display-btn"
                onClick={() => toggleMenu('display')}
              >
                <IcSliders size={15} />
              </button>
            </Hint>
          }
          menu={
            <div className="tp-light-menu">
              <div className="tp-menu-heading">Display</div>
              <div className="tp-field-row">
                <span className="tp-field-label">Wireframe</span>
                <Toggle
                  on={wireframe}
                  onChange={(v) => set('wireframe', v)}
                  testid="tp-wireframe-toggle"
                />
              </div>
              <div className="tp-field-row">
                <span className="tp-field-label">Turntable</span>
                <Toggle on={autoRotate} onChange={(v) => set('autoRotate', v)} />
              </div>
            </div>
          }
        />
        <span className="tp-strip-sep" />
        {MATERIAL_SPHERES.map((m) => (
          <Hint key={m.id} text={m.hint}>
            <button
              type="button"
              className="tp-strip-btn"
              data-active={material === m.id && renderMode === 'shaded'}
              data-testid={`tp-mat-${m.id}`}
              onClick={() => {
                set('material', m.id);
                set('renderMode', 'shaded');
              }}
            >
              <span className={`tp-sphere ${m.cls}`} />
            </button>
          </Hint>
        ))}
      </div>
    </div>
  );
}

// ── bottom action pill ────────────────────────────────────────────────────
function ActionBar(): JSX.Element {
  const autoRotate = useTripoStore((s) => s.autoRotate);
  const set = useTripoStore((s) => s.set);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const favorites = useTripoStore((s) => s.favorites);
  const toggleList = useTripoStore((s) => s.toggleList);
  const fav = loadedAssetId !== null && favorites.includes(loadedAssetId);

  return (
    <div className="tp-actionbar" data-testid="tp-actionbar">
      <Hint text="Undo">
        <button type="button" className="tp-action-btn" disabled>
          <IcUndo size={16} />
        </button>
      </Hint>
      <Hint text="Redo">
        <button type="button" className="tp-action-btn" disabled>
          <IcRedo size={16} />
        </button>
      </Hint>
      <span className="tp-action-sep" />
      <Hint text="Daily rewards">
        <button type="button" className="tp-action-btn">
          <IcGift size={16} />
        </button>
      </Hint>
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
      <span className="tp-action-sep" />
      <button type="button" className="tp-action-btn tp-action-labeled">
        <IcPrinter size={16} />
        3D Print
      </button>
      <Hint text="Favorite">
        <button
          type="button"
          className="tp-action-btn"
          data-active={fav}
          onClick={() => {
            if (loadedAssetId !== null) toggleList('favorites', loadedAssetId);
          }}
        >
          <IcStar size={16} />
        </button>
      </Hint>
      <Hint text="Share & earn credits">
        <button type="button" className="tp-action-btn tp-share-btn">
          <span className="tp-share-plus">+300</span>
          <IcShare size={16} />
        </button>
      </Hint>
      <button
        type="button"
        className="tp-export-cta"
        data-testid="tp-export-btn"
        onClick={() => set('modal', 'export')}
      >
        <IcDownload size={15} />
        Export
      </button>
    </div>
  );
}

// ── export dialog + send-to menu ──────────────────────────────────────────
function SelectRow({
  label,
  value,
  menuId,
  options,
  onPick,
}: {
  readonly label: string;
  readonly value: string;
  readonly menuId: string;
  readonly options: readonly string[];
  readonly onPick: (v: string) => void;
}): JSX.Element {
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  return (
    <div className="tp-field-row tp-field-row-wide">
      <span className="tp-field-label">{label}</span>
      <MenuAnchor
        id={menuId}
        placement="bottom-end"
        trigger={
          <button
            type="button"
            className="tp-select"
            data-testid={`tp-select-${menuId}`}
            onClick={() => toggleMenu(menuId)}
          >
            {value}
            <IcCaretSmall size={12} />
          </button>
        }
        menu={options.map((o) => (
          <button
            key={o}
            type="button"
            className="tp-menu-item"
            onClick={() => {
              onPick(o);
              closeMenus();
            }}
          >
            <span className="tp-menu-item-label">{o}</span>
          </button>
        ))}
      />
    </div>
  );
}

function ExportDialog(): JSX.Element {
  const set = useTripoStore((s) => s.set);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const asset = TRIPO_ASSETS.find((a) => a.id === loadedAssetId);
  const [name, setName] = useState(asset?.name ?? 'tripo_model');
  const [format, setFormat] = useState<string>(EXPORT_FORMATS[0]);
  const [quality, setQuality] = useState<string>(EXPORT_QUALITY[0]);
  const [pack, setPack] = useState(true);

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
      <SelectRow
        label="Format"
        value={format}
        menuId="exportformat"
        options={EXPORT_FORMATS}
        onPick={setFormat}
      />
      <SelectRow
        label="Quality"
        value={quality}
        menuId="exportquality"
        options={EXPORT_QUALITY}
        onPick={setQuality}
      />
      <div className="tp-field-row tp-field-row-wide">
        <span className="tp-field-label">Pack textures</span>
        <Toggle on={pack} onChange={setPack} />
      </div>
      <div className="tp-export-actions">
        <MenuAnchor
          id="sendto"
          placement="top-start"
          trigger={
            <button
              type="button"
              className="tp-sendto-btn"
              data-testid="tp-sendto-btn"
              onClick={() => toggleMenu('sendto')}
            >
              Send To
              <IcShare size={14} />
            </button>
          }
          menu={
            <div className="tp-sendto-menu" data-testid="tp-sendto-menu">
              {SEND_TO_TARGETS.map((t) => (
                <button key={t.id} type="button" className="tp-menu-item">
                  <span className={`tp-dcc-glyph tp-dcc-${t.id}`}>
                    {t.label.charAt(8).toUpperCase()}
                  </span>
                  <span className="tp-menu-item-label">{t.label}</span>
                  {t.beta === true ? <span className="tp-badge-soft">Beta</span> : null}
                </button>
              ))}
            </div>
          }
        />
        <button type="button" className="tp-export-confirm" data-testid="tp-export-confirm">
          <IcBolt size={14} />
          Export
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
  const gizmoRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(0);
  const asset = TRIPO_ASSETS.find((a) => a.id === loadedAssetId);
  // Stats reflect the current pipeline result: the dense triangulated base
  // mesh vs. the clean quad remesh the rig/animation stages run on. Counts
  // match the bundled hero GLBs (see build-hero-glb.mjs).
  const stats =
    pipelineStage === 'mesh'
      ? { topology: 'Triangle', faces: 21600, vertices: 10872 }
      : { topology: 'Quad', faces: 320, vertices: 336 };

  return (
    <div className="tp-viewport" data-testid="tp-viewport">
      {asset !== undefined ? (
        <Suspense fallback={<div className="tp-canvas-loading">Preparing viewer…</div>}>
          <Viewer3D gizmoRef={gizmoRef} />
        </Suspense>
      ) : (
        <div className="tp-empty" data-testid="tp-empty-state">
          <LogoMark size={54} />
          <h1>Ready For A New 3D Model?</h1>
          <p>Instantly generate 3D from image or text</p>
        </div>
      )}

      {asset !== undefined ? (
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

      {asset !== undefined ? (
        <>
          <MaterialStrip />
          <ActionBar />
        </>
      ) : null}

      {modal === 'export' ? <ExportDialog /> : null}
      {modal === 'help' ? <HelpModal /> : null}
    </div>
  );
}
