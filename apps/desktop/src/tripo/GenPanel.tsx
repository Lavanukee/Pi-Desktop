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
import { Hint, MenuAnchor, MenuItem, Segmented, SliderRow } from './primitives';
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

      {inputMode === 'image' ? (
        <div className="tp-dropzone" data-testid="tp-dropzone">
          <Hint text="Tips: clean background, single subject" side="left">
            <span className="tp-dropzone-bulb">
              <IcBulb size={15} />
            </span>
          </Hint>
          <IcImage size={26} />
          <div className="tp-dropzone-title">Upload</div>
          <div className="tp-dropzone-sub">JPG, PNG, WEBP · Size ≤ 20MB</div>
          <button type="button" className="tp-gen-image-link">
            Generate Image for 3D
            <IcChevronRight size={13} />
          </button>
        </div>
      ) : null}

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

  return (
    <>
      <PanelHeader icon={<IcSparkles size={17} />} title="Generate Model" />
      <div className="tp-panel-scroll">
        <UploadZone />
        <div className="tp-section-title">Settings</div>
        <GeoAccordion />
        <AiModelSelect />
      </div>
      <div className="tp-panel-foot">
        {/* Sample-asset-backed: loads the bundled sample GLB and shows its dense
         * generated base mesh. NOT a live Hunyuan/TRELLIS run yet. */}
        <GenerateButton
          label="Generate Model"
          testid="tp-generate-btn"
          onClick={() => {
            loadAsset(HERO_ASSET_ID);
            runStage('mesh');
          }}
        />
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
        <GenerateButton label="Generate Image" />
      </div>
    </>
  );
}

// ── Segment / Retopo / Texture panels (functional stages) ─────────────────

function StagePanel({
  icon,
  title,
  engine,
  copy,
  footer,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly engine: string;
  readonly copy: string;
  readonly footer: ReactNode;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <>
      <PanelHeader icon={icon} title={title} />
      <div className="tp-panel-scroll">
        <EngineRow name={engine} />
        <p className="tp-select-copy">{copy}</p>
        <UploadModelButton />
        {children}
      </div>
      <div className="tp-panel-foot">{footer}</div>
    </>
  );
}

function SegmentPanel(): JSX.Element {
  const runStage = useTripoStore((s) => s.runStage);
  const parts = useTripoStore((s) => s.segmentParts);

  return (
    <StagePanel
      icon={<IcSegment size={17} />}
      title="Segmentation"
      engine={SEGMENT_MODEL}
      copy="Split the loaded model into semantic parts. Generate a model, pick one from Assets, or drop a file anywhere."
      footer={
        <GenerateButton
          label="Segment Parts"
          testid="tp-segment-btn"
          onClick={() => runStage('segment')}
        />
      }
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
  const runStage = useTripoStore((s) => s.runStage);
  return (
    <StagePanel
      icon={<IcRetopo size={17} />}
      title="Retopology"
      engine={RETOPO_MODEL}
      copy="Rebuild the loaded model as clean quad topology and reveal its wireframe."
      footer={
        /* Sample-asset-backed for the sample creature (bundled quad remesh);
         * an imported model shows its real edge wireframe. */
        <GenerateButton
          label="Start Retopology"
          testid="tp-retopo-btn"
          onClick={() => runStage('retopo')}
        />
      }
    />
  );
}

function TexturePanel(): JSX.Element {
  const runStage = useTripoStore((s) => s.runStage);
  return (
    <StagePanel
      icon={<IcTexture size={17} />}
      title="Texture"
      engine={TEXTURE_MODEL}
      copy="Generate a texture for the loaded model and view it in Textured mode."
      footer={
        <GenerateButton
          label="Generate Texture"
          testid="tp-texture-btn"
          onClick={() => runStage('texture')}
        />
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
