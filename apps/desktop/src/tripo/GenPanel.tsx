/**
 * The left panel — content switches with the rail tool, and is REPLACED by the
 * engine-download panel while that's open (a full-height left module, jedd).
 * Every section runs on a REAL model (engine-generated or user-imported) — no
 * bundled placeholder. Where a stage's engine model isn't installed the panel
 * offers its download prominently rather than faking a run:
 *  - Model: image(s)/text input + geometry settings + AI model + Generate.
 *    Image input takes one-or-more UNLABELED images (TRELLIS-2 pools them —
 *    more improve accuracy).
 *  - Image: text → image (Mage-Flow), then Export / Make 3D on the result.
 *  - Segment (CubePart) / Retopo (AutoRemesher) / Texture (Hunyuan Paint):
 *    run on the loaded model; each prompts its own model download when missing.
 *  - Animate (SkinTokens rig / ARDY motion): AnimatePanel.
 */
import type { JSX, ReactNode } from 'react';
import { useRef, useState } from 'react';
import type { Gen3dModelId, Gen3dRole } from '../../electron/gen3d/gen3d-contract';
import { AnimatePanel } from './AnimatePanel';
import { GEN_MODELS, RETOPO_MODEL, SEGMENT_MODEL, TEXTURE_MODEL } from './data';
import { CapabilityLoop, DownloadPanel } from './gen-ui';
import { formatGb, useGen3dStore } from './gen3d-client';
import {
  IcBulb,
  IcCaretSmall,
  IcChevronRight,
  IcClose,
  IcCube,
  IcDownload,
  IcImage,
  IcPencil,
  IcPlus,
  IcRetopo,
  IcSegment,
  IcSparkles,
  IcTexture,
  IcUpload,
} from './icons';
import { Hint, MenuAnchor, MenuItem, Segmented, SliderRow, Toggle } from './primitives';
import { type TripoInputMode, useTripoStore } from './store';
import { addInputImages, importModelFile, MAX_INPUT_IMAGES } from './viewer-io';

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

/** A download call-to-action button styled as the primary action for a stage
 * whose engine model isn't installed — opens the download panel focused on it.
 * (A stage never shows a runnable-looking button before it can actually run.) */
function DownloadCta({
  modelId,
  label,
  sizeBytes,
  testid,
}: {
  readonly modelId: Gen3dModelId;
  readonly label: string;
  readonly sizeBytes: number;
  readonly testid?: string;
}): JSX.Element {
  const open = useGen3dStore((s) => s.setDownloadPromptOpen);
  return (
    <button
      type="button"
      className="tp-generate-btn tp-generate-btn-dl"
      data-testid={testid}
      onClick={() => open(true, modelId)}
    >
      <IcDownload size={15} />
      Download {label}
      {sizeBytes > 0 ? ` · ${formatGb(sizeBytes)}` : ''}
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

/** The "this stage needs its model" card: the capability loop + a download
 * button. Prominent, not a footnote. */
function StageNeedsModel({
  capability,
  modelId,
}: {
  readonly capability: Gen3dRole;
  readonly modelId: Gen3dModelId;
}): JSX.Element | null {
  const model = useGen3dStore((s) => s.models.find((m) => m.id === modelId));
  const open = useGen3dStore((s) => s.setDownloadPromptOpen);
  if (model === undefined) return null;
  return (
    <button
      type="button"
      className="tp-needs-model"
      data-testid={`tp-needs-${modelId}`}
      onClick={() => open(true, modelId)}
    >
      <div className="tp-needs-loop">
        <CapabilityLoop role={capability} />
      </div>
      <div className="tp-needs-body">
        <span className="tp-needs-title">Runs on {model.label}</span>
        <span className="tp-needs-sub">
          Not installed yet — download{model.sizeBytes > 0 ? ` (${formatGb(model.sizeBytes)})` : ''}{' '}
          to enable this stage.
        </span>
      </div>
      <IcDownload size={16} />
    </button>
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

/** Image→3D input: one-or-more UNLABELED images with live thumbnails. One
 * image = single image→3D; more = multi-image conditioning (TRELLIS pools
 * them, more improve accuracy). Files come via the picker or a drop. */
function ImagesZone(): JSX.Element {
  const genImages = useTripoStore((s) => s.genImages);
  const set = useTripoStore((s) => s.set);
  const inputRef = useRef<HTMLInputElement>(null);

  const openPicker = () => inputRef.current?.click();
  const remove = (path: string) => {
    const img = genImages.find((i) => i.path === path);
    if (img !== undefined) URL.revokeObjectURL(img.url);
    set(
      'genImages',
      genImages.filter((i) => i.path !== path),
    );
  };

  const hiddenInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      multiple
      style={{ display: 'none' }}
      data-testid="tp-image-input"
      onChange={(e) => {
        if (e.target.files !== null) addInputImages(Array.from(e.target.files));
        e.target.value = '';
      }}
    />
  );

  if (genImages.length === 0) {
    return (
      <>
        <button
          type="button"
          className="tp-dropzone"
          data-testid="tp-dropzone"
          data-picked={false}
          onClick={openPicker}
        >
          <Hint text="Tips: clean background, single subject" side="bottom">
            <span className="tp-dropzone-bulb">
              <IcBulb size={15} />
            </span>
          </Hint>
          <IcImage size={26} />
          <div className="tp-dropzone-title">Choose or drop image(s)</div>
          <div className="tp-dropzone-sub">
            One image works — add more views of the same subject to improve accuracy
          </div>
        </button>
        {hiddenInput}
      </>
    );
  }

  return (
    <div className="tp-images" data-testid="tp-images">
      <div className="tp-images-grid">
        {genImages.map((img) => (
          <div className="tp-image-tile" key={img.path} title={img.name}>
            <img src={img.url} alt={img.name} />
            <button
              type="button"
              className="tp-image-remove"
              aria-label={`Remove ${img.name}`}
              onClick={() => remove(img.path)}
            >
              <IcClose size={11} />
            </button>
          </div>
        ))}
        {genImages.length < MAX_INPUT_IMAGES ? (
          <button
            type="button"
            className="tp-image-add"
            data-testid="tp-image-add"
            onClick={openPicker}
          >
            <IcPlus size={18} />
            <span>Add</span>
          </button>
        ) : null}
      </div>
      <p className="tp-images-hint">
        {genImages.length === 1
          ? 'Single image → 3D. Add more views to improve accuracy.'
          : `${genImages.length} views → multi-image 3D (up to ${MAX_INPUT_IMAGES}; more improve accuracy).`}
      </p>
      {hiddenInput}
    </div>
  );
}

const INPUT_TABS: readonly { id: TripoInputMode; icon: ReactNode; hint: string }[] = [
  { id: 'image', icon: <IcCube size={16} />, hint: 'Image(s) to 3D' },
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

      {inputMode === 'image' ? <ImagesZone /> : null}

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
  const inputMode = useTripoStore((s) => s.inputMode);
  const prompt = useTripoStore((s) => s.prompt);
  const genImages = useTripoStore((s) => s.genImages);
  const genResolution = useTripoStore((s) => s.genResolution);
  const genAutoTexture = useTripoStore((s) => s.genAutoTexture);
  const set = useTripoStore((s) => s.set);

  const engineReady = useGen3dStore((s) => s.engineReady);
  const models = useGen3dStore((s) => s.models);
  const resolutions = useGen3dStore((s) => s.resolutions);
  const job = useGen3dStore((s) => s.job);
  const generate = useGen3dStore((s) => s.generate);
  const openDownload = useGen3dStore((s) => s.setDownloadPromptOpen);

  const installed = (id: Gen3dModelId): boolean =>
    models.find((m) => m.id === id)?.installed === true;
  // Text→3D needs Mage-Flow for the first hop; image→3D just TRELLIS.
  const geometryReady = engineReady && installed('trellis2');
  const canRunReal = geometryReady && (inputMode !== 'text' || installed('mageflow'));
  const busy = job !== null && !job.done;
  const missingInput =
    (inputMode === 'text' && prompt.trim().length === 0) ||
    (inputMode === 'image' && genImages.length === 0);

  const onGenerate = () => {
    // Without the models, Generate is the DOWNLOAD path — never a fake run. Aim
    // the download panel at the first missing model for this input.
    if (!geometryReady) {
      openDownload(true, 'trellis2');
      return;
    }
    if (inputMode === 'text' && !installed('mageflow')) {
      openDownload(true, 'mageflow');
      return;
    }
    if (missingInput) return;
    void generate({
      kind: inputMode === 'text' ? 'text' : 'image',
      ...(inputMode === 'text' ? { prompt: prompt.trim() } : {}),
      ...(inputMode === 'image' ? { imagePaths: genImages.map((i) => i.path) } : {}),
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
          <span className="tp-field-label">Auto-texture</span>
          <Toggle
            on={genAutoTexture}
            onChange={(v) => set('genAutoTexture', v)}
            testid="tp-autotexture-toggle"
          />
        </div>
        <GeoAccordion />
        <AiModelSelect />
      </div>
      <div className="tp-panel-foot">
        {canRunReal ? (
          <GenerateButton
            label={busy ? 'Generating…' : 'Generate Model'}
            disabled={busy || missingInput}
            testid="tp-generate-btn"
            onClick={onGenerate}
          />
        ) : (
          <DownloadCta
            modelId={inputMode === 'text' && geometryReady ? 'mageflow' : 'trellis2'}
            label={inputMode === 'text' && geometryReady ? 'Mage-Flow' : 'TRELLIS-2'}
            sizeBytes={
              models.find(
                (m) => m.id === (inputMode === 'text' && geometryReady ? 'mageflow' : 'trellis2'),
              )?.sizeBytes ?? 0
            }
            testid="tp-generate-btn"
          />
        )}
      </div>
    </>
  );
}

// ── Image panel (text → image, then Export / Make 3D) ─────────────────────

function ImagePanel(): JSX.Element {
  const [ratio, setRatio] = useState<'1:1' | '16:9' | '9:16'>('1:1');
  const [prompt, setPrompt] = useState('');
  const genResolution = useTripoStore((s) => s.genResolution);
  const genAutoTexture = useTripoStore((s) => s.genAutoTexture);
  const engineReady = useGen3dStore((s) => s.engineReady);
  const models = useGen3dStore((s) => s.models);
  const job = useGen3dStore((s) => s.job);
  const generate = useGen3dStore((s) => s.generate);
  const openDownload = useGen3dStore((s) => s.setDownloadPromptOpen);

  const mageReady = engineReady && models.find((m) => m.id === 'mageflow')?.installed === true;
  const trellisInstalled = models.find((m) => m.id === 'trellis2')?.installed === true;
  const busy = job !== null && !job.done;
  // A finished image sitting in the viewport readout is the one we act on.
  const resultImage =
    job?.done === true && job.artifact?.kind === 'image' ? job.artifact.path : null;

  const exportImage = () => {
    if (resultImage === null) return;
    const a = document.createElement('a');
    a.href = `pd-file://f${resultImage.split('/').map(encodeURIComponent).join('/')}`;
    a.download = resultImage.split('/').pop() ?? 'image.png';
    a.click();
  };

  const mageSize = models.find((m) => m.id === 'mageflow')?.sizeBytes ?? 0;

  return (
    <>
      <PanelHeader icon={<IcImage size={17} />} title="Image for 3D" />
      <div className="tp-panel-scroll">
        <div className="tp-card tp-card-pad">
          <textarea
            className="tp-prompt"
            data-testid="tp-image-prompt"
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
        {resultImage !== null ? (
          <div className="tp-image-result" data-testid="tp-image-result">
            <div className="tp-section-title">Generated image</div>
            <img
              className="tp-image-result-thumb"
              src={`pd-file://f${resultImage.split('/').map(encodeURIComponent).join('/')}`}
              alt="Generated"
            />
            <div className="tp-image-result-actions">
              <button
                type="button"
                className="tp-upload-btn"
                data-testid="tp-image-export"
                onClick={exportImage}
              >
                <IcDownload size={14} />
                Export image
              </button>
              <button
                type="button"
                className="tp-generate-btn tp-generate-btn-inline"
                data-testid="tp-image-make3d"
                disabled={!trellisInstalled}
                onClick={() => {
                  if (!trellisInstalled) {
                    openDownload(true, 'trellis2');
                    return;
                  }
                  void generate({
                    kind: 'image',
                    imagePaths: [resultImage],
                    resolution: genResolution,
                    texture: genAutoTexture,
                  });
                }}
              >
                <IcCube size={14} />
                Make 3D
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="tp-panel-foot">
        {mageReady ? (
          <GenerateButton
            label={busy ? 'Generating…' : 'Generate Image'}
            disabled={busy || prompt.trim().length === 0}
            testid="tp-image-generate-btn"
            onClick={() =>
              void generate({
                kind: 'text',
                prompt: prompt.trim(),
                resolution: genResolution,
                texture: genAutoTexture,
                imageOnly: true,
              })
            }
          />
        ) : (
          <DownloadCta
            modelId="mageflow"
            label="Mage-Flow"
            sizeBytes={mageSize}
            testid="tp-image-generate-btn"
          />
        )}
      </div>
    </>
  );
}

// ── Segment / Retopo / Texture panels (run on the loaded model) ───────────

/**
 * Shared stage panel. It's aware of what's in the viewport AND whether its
 * engine model is installed:
 *  - engine missing → a prominent "runs on <Model>" download card + a Download
 *    button as the footer action (never a runnable-looking button that can't).
 *  - installed, nothing loaded → invite generate/upload/drop.
 *  - installed + model loaded → the real Target row + the run button.
 */
function StagePanel({
  icon,
  title,
  engine,
  engineId,
  capability,
  runLabel,
  runTestid,
  emptyCopy,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly engine: string;
  readonly engineId: Gen3dModelId;
  readonly capability: Gen3dRole;
  readonly runLabel: string;
  readonly runTestid: string;
  readonly emptyCopy: string;
  readonly children?: ReactNode;
}): JSX.Element {
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const assets = useTripoStore((s) => s.assets);
  const engineReady = useGen3dStore((s) => s.engineReady);
  const models = useGen3dStore((s) => s.models);
  const runStageEngine = useGen3dStore((s) => s.runStage);
  const loaded = assets.find((a) => a.id === loadedAssetId);
  const engineModel = models.find((m) => m.id === engineId);
  const engineInstalled = engineReady && engineModel?.installed === true;

  const op = capability as 'segment' | 'retopo' | 'texture';

  let footer: ReactNode;
  if (!engineInstalled) {
    footer = (
      <DownloadCta
        modelId={engineId}
        label={engine}
        sizeBytes={engineModel?.sizeBytes ?? 0}
        testid={runTestid}
      />
    );
  } else if (loaded === undefined) {
    footer = <GenerateButton label={runLabel} disabled testid={runTestid} />;
  } else {
    footer = (
      <GenerateButton
        label={runLabel}
        testid={runTestid}
        onClick={() => {
          if (loaded.diskPath !== undefined) void runStageEngine(op, loaded.diskPath);
        }}
      />
    );
  }

  return (
    <>
      <PanelHeader icon={icon} title={title} />
      <div className="tp-panel-scroll">
        <EngineRow name={engine} />
        {!engineInstalled ? <StageNeedsModel capability={capability} modelId={engineId} /> : null}
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
        {children}
      </div>
      <div className="tp-panel-foot">{footer}</div>
    </>
  );
}

const STAGE_EMPTY =
  'Nothing in the viewport yet — generate a model, pick one from Assets, or drop a file anywhere.';

function SegmentPanel(): JSX.Element {
  const parts = useTripoStore((s) => s.segmentParts);
  return (
    <StagePanel
      icon={<IcSegment size={17} />}
      title="Segmentation"
      engine={SEGMENT_MODEL}
      engineId="cubepart"
      capability="segment"
      runLabel="Segment Parts"
      runTestid="tp-segment-btn"
      emptyCopy={STAGE_EMPTY}
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
  return (
    <StagePanel
      icon={<IcRetopo size={17} />}
      title="Retopology"
      engine={RETOPO_MODEL}
      engineId="autoremesher"
      capability="retopo"
      runLabel="Start Retopology"
      runTestid="tp-retopo-btn"
      emptyCopy={STAGE_EMPTY}
    />
  );
}

function TexturePanel(): JSX.Element {
  return (
    <StagePanel
      icon={<IcTexture size={17} />}
      title="Texture"
      engine={TEXTURE_MODEL}
      engineId="hunyuan-paint"
      capability="texture"
      runLabel="Generate Texture"
      runTestid="tp-texture-btn"
      emptyCopy={STAGE_EMPTY}
    />
  );
}

export function GenPanel(): JSX.Element {
  const tool = useTripoStore((s) => s.tool);
  const downloadOpen = useGen3dStore((s) => s.downloadPromptOpen);

  if (downloadOpen) {
    return (
      <section className="tp-genpanel" data-testid="tp-panel-download">
        <DownloadPanel />
      </section>
    );
  }

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
