/**
 * The left panel — content switches with the rail tool. Every section is
 * FUNCTIONAL on the demo pipeline (sample-asset-backed until the live engines
 * are wired; each stage is labeled with its intended real engine):
 *  - Model: input modes + geometry settings + AI model (Hunyuan 3D Omni /
 *    TRELLIS-2) + Generate → the base mesh appears in the viewport.
 *  - Image: prompt/ratio/style for the image-for-3D input.
 *  - Segment (CubePart): splits the loaded mesh into colored semantic parts.
 *  - Retopo (AutoRemesher): reveals the clean quad remesh.
 *  - Texture (Hunyuan Paint): generates + applies a texture, switches the
 *    viewport to Textured.
 *  - Animate (SkinTokens / ARDY): rigging + clip playback (AnimatePanel).
 * No credits, no members-only upsells, no privacy rows.
 */
import type { JSX, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { AnimatePanel } from './AnimatePanel';
import { GEN_MODELS, RETOPO_MODEL, SEGMENT_MODEL, TEXTURE_MODEL } from './data';
import { formatGb, useGen3dStore } from './gen3d-client';
import {
  IcBulb,
  IcCaretSmall,
  IcChevronRight,
  IcCube,
  IcGallery,
  IcImage,
  IcPencil,
  IcRetopo,
  IcSegment,
  IcSparkles,
  IcTexture,
  IcUpload,
} from './icons';
import { Hint, MenuAnchor, MenuItem, Segmented, SliderRow, Toggle } from './primitives';
import { HERO_ASSET_ID, type TripoInputMode, useTripoStore } from './store';
import { importModelFile } from './viewer-io';

// ── shared bits ───────────────────────────────────────────────────────────

function PanelHeader({
  icon,
  title,
}: {
  readonly icon: ReactNode;
  readonly title: string;
}): JSX.Element {
  return (
    <div className="tp-panel-header">
      <span className="tp-panel-header-icon">{icon}</span>
      {title}
    </div>
  );
}

function GenerateButton({
  label,
  disabled,
  testid,
  onClick,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly testid?: string;
  readonly onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="tp-generate-btn"
      disabled={disabled}
      data-testid={testid}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** "Engine · <name>" row — names the real model that backs this stage. */
function EngineRow({ name }: { readonly name: string }): JSX.Element {
  return (
    <div className="tp-engine-row" data-testid="tp-engine-row">
      <span className="tp-field-label">Model</span>
      <span className="tp-engine-name">{name}</span>
    </div>
  );
}

/** Hidden-file-input Upload button: imports a 3D model exactly like drag-drop. */
function UploadModelButton(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="tp-upload-btn"
        data-testid="tp-upload-model-btn"
        onClick={() => inputRef.current?.click()}
      >
        <IcUpload size={15} />
        Upload 3D Model
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".glb,.gltf,.obj,.stl"
        style={{ display: 'none' }}
        data-testid="tp-upload-model-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file !== undefined) void importModelFile(file);
          e.target.value = '';
        }}
      />
    </>
  );
}

// ── Generate Model panel ──────────────────────────────────────────────────

/** Image→3D input: a real picker capturing the file's disk path (the engine
 * takes paths). Shows the picked file; click again to swap. */
function ImagePickZone(): JSX.Element {
  const genImageName = useTripoStore((s) => s.genImageName);
  const set = useTripoStore((s) => s.set);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <button
      type="button"
      className="tp-dropzone"
      data-testid="tp-dropzone"
      data-picked={genImageName !== null}
      onClick={() => inputRef.current?.click()}
    >
      <Hint text="Tips: clean background, single subject" side="bottom">
        <span className="tp-dropzone-bulb">
          <IcBulb size={15} />
        </span>
      </Hint>
      <IcImage size={26} />
      <div className="tp-dropzone-title">{genImageName ?? 'Choose an image'}</div>
      <div className="tp-dropzone-sub">
        {genImageName === null ? 'JPG, PNG, WEBP' : 'Click to swap'}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        data-testid="tp-image-input"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file !== undefined) {
            const path = window.piDesktop.pathForFile(file);
            if (path.length > 0) {
              set('genImagePath', path);
              set('genImageName', file.name);
            }
          }
          e.target.value = '';
        }}
      />
    </button>
  );
}

const INPUT_TABS: readonly { id: TripoInputMode; icon: ReactNode; hint: string }[] = [
  { id: 'image', icon: <IcImage size={16} />, hint: 'Image to 3D' },
  { id: 'multiview', icon: <IcCube size={16} />, hint: 'Multi-view to 3D' },
  { id: 'gallery', icon: <IcGallery size={16} />, hint: 'From my gallery' },
  { id: 'text', icon: <IcPencil size={16} />, hint: 'Text to 3D' },
];

function UploadZone(): JSX.Element {
  const inputMode = useTripoStore((s) => s.inputMode);
  const set = useTripoStore((s) => s.set);
  const prompt = useTripoStore((s) => s.prompt);

  return (
    <div className="tp-input-card" data-testid="tp-input-card">
      <div className="tp-input-tabs">
        {INPUT_TABS.map((t) => (
          <Hint key={t.id} text={t.hint}>
            <button
              type="button"
              className="tp-input-tab"
              data-active={inputMode === t.id}
              data-testid={`tp-input-tab-${t.id}`}
              onClick={() => set('inputMode', t.id)}
            >
              {t.icon}
            </button>
          </Hint>
        ))}
      </div>

      {inputMode === 'image' ? <ImagePickZone /> : null}

      {inputMode === 'multiview' ? (
        <div className="tp-multiview">
          {(['Front', 'Back', 'Left', 'Right'] as const).map((v) => (
            <button key={v} type="button" className="tp-mv-slot" data-required={v === 'Front'}>
              <IcUpload size={15} />
              <span>{v}</span>
              {v === 'Front' ? <em>required</em> : null}
            </button>
          ))}
        </div>
      ) : null}

      {inputMode === 'gallery' ? (
        <div className="tp-mini-gallery">
          {['Mecha scout', 'Clay fox', 'Lantern', 'Ruined tower', 'Bonsai', 'Sword'].map((g, i) => (
            <button key={g} type="button" className="tp-mini-thumb" data-i={i % 4} title={g}>
              <IcImage size={15} />
            </button>
          ))}
          <div className="tp-mini-gallery-note">Pick a generated image to lift into 3D</div>
        </div>
      ) : null}

      {inputMode === 'text' ? (
        <div className="tp-textmode">
          <textarea
            className="tp-prompt"
            data-testid="tp-prompt"
            placeholder="Describe your model… e.g. a weathered bronze astrolabe with engraved constellations"
            value={prompt}
            onChange={(e) => set('prompt', e.target.value)}
            rows={4}
          />
          <div className="tp-prompt-foot">
            <span>{prompt.length}/1024</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GeoAccordion(): JSX.Element {
  const open = useTripoStore((s) => s.geoTexOpen);
  const set = useTripoStore((s) => s.set);
  const faceLimit = useTripoStore((s) => s.faceLimit);
  const topology = useTripoStore((s) => s.topology);
  const symmetry = useTripoStore((s) => s.symmetry);

  return (
    <div className="tp-accordion" data-open={open}>
      <button
        type="button"
        className="tp-accordion-head"
        data-testid="tp-geotex-head"
        onClick={() => set('geoTexOpen', !open)}
      >
        <div className="tp-accordion-titles">
          <span className="tp-accordion-title">Geometry</span>
          <span className="tp-accordion-sub">Face limit · topology · symmetry</span>
        </div>
        <span className="tp-accordion-caret">
          <IcChevronRight size={15} />
        </span>
      </button>
      {open ? (
        <div className="tp-accordion-body" data-testid="tp-geotex-body">
          <SliderRow
            label="Face limit"
            value={faceLimit}
            display={faceLimit >= 100 ? 'Adaptive' : `${faceLimit}K`}
            min={2}
            max={100}
            onChange={(v) => set('faceLimit', v)}
          />
          <div className="tp-field-row">
            <span className="tp-field-label">Topology</span>
            <Segmented
              size="sm"
              options={[
                { id: 'triangle', label: 'Triangle' },
                { id: 'quad', label: 'Quad' },
              ]}
              value={topology}
              onChange={(v) => set('topology', v)}
            />
          </div>
          <div className="tp-field-row">
            <span className="tp-field-label">Symmetry</span>
            <Segmented
              size="sm"
              options={[
                { id: 'auto', label: 'Auto' },
                { id: 'on', label: 'On' },
                { id: 'off', label: 'Off' },
              ]}
              value={symmetry}
              onChange={(v) => set('symmetry', v)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AiModelSelect(): JSX.Element {
  const genModel = useTripoStore((s) => s.genModel);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const set = useTripoStore((s) => s.set);
  const openMenu = useTripoStore((s) => s.openMenu);
  const current = GEN_MODELS.find((m) => m.id === genModel) ?? GEN_MODELS[0];
  if (current === undefined) return <div />;

  return (
    <div className="tp-section">
      <div className="tp-section-title">AI Model</div>
      <MenuAnchor
        id="genmodel"
        placement="top-start"
        className="tp-anchor-block"
        trigger={
          <button
            type="button"
            className="tp-model-select"
            data-testid="tp-genmodel-btn"
            onClick={() => toggleMenu('genmodel')}
          >
            <span className="tp-model-titles">
              <span className="tp-model-name">{current.label}</span>
              <span className="tp-model-hint">{current.hint}</span>
            </span>
            <span className="tp-model-caret" data-open={openMenu === 'genmodel'}>
              <IcCaretSmall size={13} />
            </span>
          </button>
        }
        menu={GEN_MODELS.map((m) => (
          <MenuItem
            key={m.id}
            label={m.label}
            hint={m.hint}
            checked={m.id === genModel}
            testid={`tp-genmodel-${m.id}`}
            onClick={() => {
              set('genModel', m.id);
              closeMenus();
            }}
          />
        ))}
      />
    </div>
  );
}

function ModelPanel(): JSX.Element {
  const runStage = useTripoStore((s) => s.runStage);
  const loadAsset = useTripoStore((s) => s.loadAsset);
  const inputMode = useTripoStore((s) => s.inputMode);
  const prompt = useTripoStore((s) => s.prompt);
  const genImagePath = useTripoStore((s) => s.genImagePath);
  const genResolution = useTripoStore((s) => s.genResolution);
  const genAutoTexture = useTripoStore((s) => s.genAutoTexture);
  const set = useTripoStore((s) => s.set);

  const engineReady = useGen3dStore((s) => s.engineReady);
  const models = useGen3dStore((s) => s.models);
  const resolutions = useGen3dStore((s) => s.resolutions);
  const job = useGen3dStore((s) => s.job);
  const generate = useGen3dStore((s) => s.generate);
  const setDownloadPromptOpen = useGen3dStore((s) => s.setDownloadPromptOpen);

  const installed = (id: string): boolean => models.find((m) => m.id === id)?.installed === true;
  // Text→3D needs Mage-Flow for the first hop; image→3D just TRELLIS.
  const canRunReal =
    engineReady && installed('trellis2') && (inputMode !== 'text' || installed('mageflow'));
  const busy = job !== null && !job.done;
  const missingInput =
    (inputMode === 'text' && prompt.trim().length === 0) ||
    (inputMode === 'image' && genImagePath === null);

  const onGenerate = () => {
    // Without the engine, Generate is the DOWNLOAD path — never a fake run.
    if (!canRunReal) {
      setDownloadPromptOpen(true);
      return;
    }
    if (missingInput) return;
    void generate({
      kind: inputMode === 'text' ? 'text' : 'image',
      ...(inputMode === 'text' ? { prompt: prompt.trim() } : {}),
      ...(inputMode !== 'text' && genImagePath !== null ? { imagePath: genImagePath } : {}),
      resolution: genResolution,
      texture: genAutoTexture,
    });
  };

  return (
    <>
      <PanelHeader icon={<IcSparkles size={17} />} title="Generate Model" />
      <div className="tp-panel-scroll">
        <UploadZone />
        <div className="tp-section-title">Settings</div>
        <div className="tp-field-row">
          <span className="tp-field-label">Resolution</span>
          <Segmented
            size="sm"
            testid="tp-resolution"
            options={[
              { id: 'low', label: String(resolutions.low) },
              { id: 'medium', label: String(resolutions.medium) },
              { id: 'high', label: String(resolutions.high) },
            ]}
            value={genResolution}
            onChange={(v) => set('genResolution', v)}
          />
        </div>
        <div className="tp-field-row">
          <span className="tp-field-label">Auto-texture (Hunyuan Paint)</span>
          <Toggle
            on={genAutoTexture}
            onChange={(v) => set('genAutoTexture', v)}
            testid="tp-autotexture-toggle"
          />
        </div>
        <GeoAccordion />
        <AiModelSelect />
        {!canRunReal ? (
          <p className="tp-select-copy" data-testid="tp-engine-missing-note">
            The generation models aren't downloaded yet — Generate opens the download prompt (sizes
            shown before anything starts).
          </p>
        ) : null}
      </div>
      <div className="tp-panel-foot">
        <GenerateButton
          label={busy ? 'Generating…' : 'Generate Model'}
          disabled={busy || (canRunReal && missingInput)}
          testid="tp-generate-btn"
          onClick={onGenerate}
        />
        {/* The bundled sample stays one explicit click away (labeled as such —
         * never presented as a generation result). */}
        <button
          type="button"
          className="tp-linklike tp-sample-link"
          data-testid="tp-load-sample"
          onClick={() => {
            loadAsset(HERO_ASSET_ID);
            runStage('mesh');
          }}
        >
          Load bundled sample instead
        </button>
      </div>
    </>
  );
}

// ── Image panel ───────────────────────────────────────────────────────────

function ImagePanel(): JSX.Element {
  const [ratio, setRatio] = useState<'1:1' | '16:9' | '9:16'>('1:1');
  const [style, setStyle] = useState('Realistic render');
  const [prompt, setPrompt] = useState('');
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const genResolution = useTripoStore((s) => s.genResolution);
  const genAutoTexture = useTripoStore((s) => s.genAutoTexture);
  const engineReady = useGen3dStore((s) => s.engineReady);
  const models = useGen3dStore((s) => s.models);
  const job = useGen3dStore((s) => s.job);
  const generate = useGen3dStore((s) => s.generate);
  const setDownloadPromptOpen = useGen3dStore((s) => s.setDownloadPromptOpen);
  // The image panel feeds the 3D flow (Mage-Flow → TRELLIS).
  const canRunReal =
    engineReady &&
    models.find((m) => m.id === 'mageflow')?.installed === true &&
    models.find((m) => m.id === 'trellis2')?.installed === true;
  const busy = job !== null && !job.done;

  return (
    <>
      <PanelHeader icon={<IcImage size={17} />} title="Image for 3D" />
      <div className="tp-panel-scroll">
        <div className="tp-card tp-card-pad">
          <textarea
            className="tp-prompt"
            placeholder="Describe the image to generate… it becomes the input for 3D"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="tp-prompt-foot">
            <span>{prompt.length}/800</span>
          </div>
        </div>
        <div className="tp-field-row">
          <span className="tp-field-label">Aspect ratio</span>
          <Segmented
            size="sm"
            options={[
              { id: '1:1', label: '1:1' },
              { id: '16:9', label: '16:9' },
              { id: '9:16', label: '9:16' },
            ]}
            value={ratio}
            onChange={setRatio}
          />
        </div>
        <div className="tp-field-row">
          <span className="tp-field-label">Style</span>
          <MenuAnchor
            id="imgstyle"
            placement="bottom-end"
            trigger={
              <button type="button" className="tp-select" onClick={() => toggleMenu('imgstyle')}>
                {style}
                <IcCaretSmall size={12} />
              </button>
            }
            menu={['Realistic render', 'Clay sculpt', 'Toon shaded', 'Concept art'].map((s) => (
              <MenuItem
                key={s}
                label={s}
                checked={s === style}
                onClick={() => {
                  setStyle(s);
                  closeMenus();
                }}
              />
            ))}
          />
        </div>
      </div>
      <div className="tp-panel-foot">
        {/* Runs the text→image→3D chain (Mage-Flow first hop); without the
         * engine it opens the download prompt. */}
        <GenerateButton
          label={busy ? 'Generating…' : 'Generate Image for 3D'}
          disabled={busy || (canRunReal && prompt.trim().length === 0)}
          testid="tp-image-generate-btn"
          onClick={() => {
            if (!canRunReal) {
              setDownloadPromptOpen(true);
              return;
            }
            void generate({
              kind: 'text',
              prompt: prompt.trim(),
              resolution: genResolution,
              texture: genAutoTexture,
            });
          }}
        />
      </div>
    </>
  );
}

// ── Segment / Retopo / Texture panels (functional stages) ─────────────────

/**
 * Shared stage panel, aware of what's in the viewport: with a model loaded it
 * shows the TARGET (never "upload a model" again); empty, it invites
 * generate/upload/drop. If the stage's real engine model isn't installed it
 * offers the download (with its size); the button still runs the local
 * geometry pass so the studio works pre-download.
 */
function StagePanel({
  icon,
  title,
  engine,
  engineId,
  emptyCopy,
  footer,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly engine: string;
  readonly engineId: 'cubepart' | 'autoremesher' | 'hunyuan-paint';
  readonly emptyCopy: string;
  readonly footer: ReactNode;
  readonly children?: ReactNode;
}): JSX.Element {
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const assets = useTripoStore((s) => s.assets);
  const engineReady = useGen3dStore((s) => s.engineReady);
  const models = useGen3dStore((s) => s.models);
  const setDownloadPromptOpen = useGen3dStore((s) => s.setDownloadPromptOpen);
  const loaded = assets.find((a) => a.id === loadedAssetId);
  const engineModel = models.find((m) => m.id === engineId);
  const engineInstalled = engineReady && engineModel?.installed === true;

  return (
    <>
      <PanelHeader icon={icon} title={title} />
      <div className="tp-panel-scroll">
        <EngineRow name={engine} />
        {loaded !== undefined ? (
          <div className="tp-engine-row" data-testid="tp-stage-target">
            <span className="tp-field-label">Target</span>
            <span className="tp-engine-name">{loaded.name}</span>
          </div>
        ) : (
          <>
            <p className="tp-select-copy" data-testid="tp-stage-empty-copy">
              {emptyCopy}
            </p>
            <UploadModelButton />
          </>
        )}
        {!engineInstalled && engineModel !== undefined ? (
          <button
            type="button"
            className="tp-linklike tp-engine-install-link"
            data-testid={`tp-install-${engineId}`}
            onClick={() => setDownloadPromptOpen(true)}
          >
            Install {engineModel.label}
            {engineModel.sizeBytes > 0 ? ` (${formatGb(engineModel.sizeBytes)})` : ''} for the real
            engine
          </button>
        ) : null}
        {children}
      </div>
      <div className="tp-panel-foot">{footer}</div>
    </>
  );
}

/** Engine-or-local dispatch for a stage button: the real gen3d op when the
 * engine + model are installed AND the target exists on disk; the local
 * geometry pass otherwise. */
function useStageAction(
  op: 'segment' | 'retopo' | 'texture',
  engineId: 'cubepart' | 'autoremesher' | 'hunyuan-paint',
): () => void {
  const runStageLocal = useTripoStore((s) => s.runStage);
  const engineReady = useGen3dStore((s) => s.engineReady);
  const models = useGen3dStore((s) => s.models);
  const runStageEngine = useGen3dStore((s) => s.runStage);
  return () => {
    const s = useTripoStore.getState();
    const loaded = s.assets.find((a) => a.id === s.loadedAssetId);
    const installed = engineReady && models.find((m) => m.id === engineId)?.installed === true;
    if (installed && loaded?.diskPath !== undefined) {
      void runStageEngine(op, loaded.diskPath);
      return;
    }
    runStageLocal(op);
  };
}

function SegmentPanel(): JSX.Element {
  const parts = useTripoStore((s) => s.segmentParts);
  const onSegment = useStageAction('segment', 'cubepart');

  return (
    <StagePanel
      icon={<IcSegment size={17} />}
      title="Segmentation"
      engine={SEGMENT_MODEL}
      engineId="cubepart"
      emptyCopy="Nothing in the viewport yet — generate a model, pick one from Assets, or drop a file anywhere."
      footer={<GenerateButton label="Segment Parts" testid="tp-segment-btn" onClick={onSegment} />}
    >
      {parts.length > 0 ? (
        <div className="tp-parts-list" data-testid="tp-parts-list">
          <div className="tp-section-title">Parts</div>
          {parts.map((p, i) => (
            <div key={p} className="tp-part-row" data-part={i}>
              <span className="tp-part-swatch" data-part={i} />
              {p}
            </div>
          ))}
        </div>
      ) : null}
    </StagePanel>
  );
}

function RetopoPanel(): JSX.Element {
  const onRetopo = useStageAction('retopo', 'autoremesher');
  return (
    <StagePanel
      icon={<IcRetopo size={17} />}
      title="Retopology"
      engine={RETOPO_MODEL}
      engineId="autoremesher"
      emptyCopy="Nothing in the viewport yet — generate a model, pick one from Assets, or drop a file anywhere."
      footer={<GenerateButton label="Start Retopology" testid="tp-retopo-btn" onClick={onRetopo} />}
    />
  );
}

function TexturePanel(): JSX.Element {
  const onTexture = useStageAction('texture', 'hunyuan-paint');
  return (
    <StagePanel
      icon={<IcTexture size={17} />}
      title="Texture"
      engine={TEXTURE_MODEL}
      engineId="hunyuan-paint"
      emptyCopy="Nothing in the viewport yet — generate a model, pick one from Assets, or drop a file anywhere."
      footer={
        <GenerateButton label="Generate Texture" testid="tp-texture-btn" onClick={onTexture} />
      }
    />
  );
}

export function GenPanel(): JSX.Element {
  const tool = useTripoStore((s) => s.tool);

  return (
    <section className="tp-genpanel" data-testid={`tp-panel-${tool}`}>
      {tool === 'model' ? <ModelPanel /> : null}
      {tool === 'image' ? <ImagePanel /> : null}
      {tool === 'segment' ? <SegmentPanel /> : null}
      {tool === 'retopo' ? <RetopoPanel /> : null}
      {tool === 'texture' ? <TexturePanel /> : null}
      {tool === 'animate' ? <AnimatePanel /> : null}
    </section>
  );
}
