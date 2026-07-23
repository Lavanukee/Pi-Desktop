/**
 * The left generation panel — content switches with the rail tool.
 *  - Model: the full Generate Model stack (HD/Smart Mesh, input-mode tabs,
 *    upload dropzone / multiview / gallery / text prompt, Geometry & Texture
 *    accordion, Members Only toggles, Privacy, AI Model dropdown, Generate).
 *  - Image: AI image generator (prompt, ratio, style, count).
 *  - Segment / Fill Parts / Retopo / Texture / Edit / Upscale / PBR: the
 *    select-or-upload panels with their illustrations and footer actions.
 * Every "start" action is a no-op by design (UI-only phase).
 */
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import { AnimatePanel } from './AnimatePanel';
import { GEN_MODELS } from './data';
import {
  IcBolt,
  IcBulb,
  IcCaretSmall,
  IcChevronRight,
  IcCrown,
  IcCube,
  IcGallery,
  IcGlobe,
  IcImage,
  IcLock,
  IcPbr,
  IcPencil,
  IcQuestion,
  IcRetopo,
  IcSegment,
  IcSparkles,
  IcTexture,
  IcThumbsUp,
  IcUpload,
  IcUpscale,
} from './icons';
import { Hint, MenuAnchor, MenuItem, Segmented, SliderRow, Toggle } from './primitives';
import { type TripoInputMode, useTripoStore } from './store';
import {
  QuadThumb,
  RetopoIllustration,
  RiggedThumb,
  SegmentIllustration,
  TextureIllustration,
} from './thumbs';

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
  cost,
  disabled,
  crown,
  testid,
}: {
  readonly label: string;
  readonly cost: number;
  readonly disabled?: boolean;
  readonly crown?: boolean;
  readonly testid?: string;
}): JSX.Element {
  return (
    <button type="button" className="tp-generate-btn" disabled={disabled} data-testid={testid}>
      {crown === true ? <IcCrown size={16} /> : null}
      {label}
      <span className="tp-cost">
        <IcBolt size={13} />
        <s>{cost}</s> 0
      </span>
    </button>
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
            <button type="button" className="tp-linklike">
              Surprise me
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GeoTexAccordion(): JSX.Element {
  const open = useTripoStore((s) => s.geoTexOpen);
  const set = useTripoStore((s) => s.set);
  const faceLimit = useTripoStore((s) => s.faceLimit);
  const topology = useTripoStore((s) => s.topology);
  const symmetry = useTripoStore((s) => s.symmetry);
  const pbrMaps = useTripoStore((s) => s.pbrMaps);

  return (
    <div className="tp-accordion" data-open={open}>
      <button
        type="button"
        className="tp-accordion-head"
        data-testid="tp-geotex-head"
        onClick={() => set('geoTexOpen', !open)}
      >
        <div className="tp-accordion-titles">
          <span className="tp-accordion-title">Geometry &amp; Texture</span>
          <span className="tp-accordion-sub">
            <IcSparkles size={12} />
            Ultra enabled for best results
          </span>
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
          <div className="tp-field-row">
            <span className="tp-field-label">PBR maps</span>
            <Toggle on={pbrMaps} onChange={(v) => set('pbrMaps', v)} testid="tp-pbr-toggle" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PrivacyRow(): JSX.Element {
  const open = useTripoStore((s) => s.privacyOpen);
  const privacy = useTripoStore((s) => s.privacy);
  const set = useTripoStore((s) => s.set);
  return (
    <div className="tp-privacy" data-open={open}>
      <button
        type="button"
        className="tp-setting-row tp-privacy-head"
        data-testid="tp-privacy-head"
        onClick={() => set('privacyOpen', !open)}
      >
        <span className="tp-setting-label">
          Privacy
          <Hint text="Public models appear in the community gallery">
            <span className="tp-q">
              <IcQuestion size={13} />
            </span>
          </Hint>
        </span>
        <span className="tp-privacy-value">
          {privacy === 'public' ? <IcGlobe size={14} /> : <IcLock size={14} />}
          {privacy === 'public' ? 'Public' : 'Private'}
          <span className="tp-privacy-caret" data-open={open}>
            <IcCaretSmall size={12} />
          </span>
        </span>
      </button>
      {open ? (
        <div className="tp-privacy-body">
          <button
            type="button"
            className="tp-radio-row"
            data-active={privacy === 'public'}
            onClick={() => set('privacy', 'public')}
          >
            <IcGlobe size={15} />
            <span className="tp-radio-body">
              <span>Public</span>
              <em>Anyone can view it in the community</em>
            </span>
            <span className="tp-radio-dot" data-active={privacy === 'public'} />
          </button>
          <button
            type="button"
            className="tp-radio-row"
            data-active={privacy === 'private'}
            onClick={() => set('privacy', 'private')}
          >
            <IcLock size={15} />
            <span className="tp-radio-body">
              <span>
                Private <IcCrown size={12} />
              </span>
              <em>Only you can see this model</em>
            </span>
            <span className="tp-radio-dot" data-active={privacy === 'private'} />
          </button>
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
            <span className="tp-model-avatar">
              <IcThumbsUp size={15} />
            </span>
            <span className="tp-model-titles">
              <span className="tp-model-name">{current.label}</span>
              <span className="tp-model-hint">{current.hint}</span>
            </span>
            <span className="tp-model-caret" data-open={openMenu === 'genmodel'}>
              <IcCaretSmall size={13} />
            </span>
          </button>
        }
        menu={
          <>
            {GEN_MODELS.map((m) => (
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
          </>
        }
      />
    </div>
  );
}

function ModelPanel(): JSX.Element {
  const genMode = useTripoStore((s) => s.genMode);
  const set = useTripoStore((s) => s.set);
  const generateInParts = useTripoStore((s) => s.generateInParts);
  const texture8k = useTripoStore((s) => s.texture8k);

  return (
    <>
      <PanelHeader icon={<IcSparkles size={17} />} title="Generate Model" />
      <div className="tp-panel-scroll">
        <Segmented
          testid="tp-genmode"
          options={[
            { id: 'hd', label: 'HD Model' },
            {
              id: 'smart',
              label: (
                <span className="tp-smartmesh">
                  Smart Mesh
                  <IcBolt size={12} />
                </span>
              ),
            },
          ]}
          value={genMode}
          onChange={(v) => set('genMode', v)}
        />
        <UploadZone />

        <div className="tp-section-title">General Settings</div>
        <GeoTexAccordion />

        <div className="tp-section-title tp-members">
          <IcCrown size={14} />
          Members Only
        </div>
        <div className="tp-card">
          <div className="tp-setting-row">
            <span className="tp-setting-label">
              Generate in Parts
              <span className="tp-badge-new">New</span>
              <Hint text="Splits the mesh into separable parts">
                <span className="tp-q">
                  <IcQuestion size={13} />
                </span>
              </Hint>
            </span>
            <Toggle
              on={generateInParts}
              onChange={(v) => set('generateInParts', v)}
              testid="tp-parts-toggle"
            />
          </div>
          <div className="tp-setting-note">
            <IcSparkles size={12} />
            New Function Trial x1
          </div>
          <div className="tp-card-sep" />
          <div className="tp-setting-row">
            <span className="tp-setting-label">
              8K Texture
              <span className="tp-badge-new">New</span>
              <Hint text="Ultra-resolution texture bake">
                <span className="tp-q">
                  <IcQuestion size={13} />
                </span>
              </Hint>
            </span>
            <Toggle on={texture8k} onChange={(v) => set('texture8k', v)} testid="tp-8k-toggle" />
          </div>
          <div className="tp-setting-note">
            <IcSparkles size={12} />
            8K Texture (Max Exclusive) – Free Trial
          </div>
          <div className="tp-card-sep" />
          <PrivacyRow />
        </div>

        <AiModelSelect />
      </div>
      <div className="tp-panel-foot">
        <GenerateButton label="Generate Model" cost={65} testid="tp-generate-btn" />
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
      <PanelHeader icon={<IcImage size={17} />} title="AI Image Generator" />
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
            <button type="button" className="tp-linklike">
              Surprise me
            </button>
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
            menu={
              <>
                {['Realistic render', 'Clay sculpt', 'Toon shaded', 'Concept art'].map((s) => (
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
              </>
            }
          />
        </div>
        <div className="tp-imagegrid-note">Recent generations</div>
        <div className="tp-mini-gallery tp-mini-gallery-loose">
          {[0, 1, 2, 3].map((i) => (
            <button key={i} type="button" className="tp-mini-thumb" data-i={i}>
              <IcImage size={15} />
            </button>
          ))}
        </div>
      </div>
      <div className="tp-panel-foot">
        <GenerateButton label="Generate Image" cost={10} />
      </div>
    </>
  );
}

// ── select-or-upload panels (Segment / Retopo / Texture family) ───────────

function SelectUploadPanel({
  icon,
  title,
  action,
  illustration,
  footer,
  extra,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly action: string;
  readonly illustration: ReactNode;
  readonly footer?: ReactNode;
  readonly extra?: ReactNode;
}): JSX.Element {
  return (
    <>
      <PanelHeader icon={icon} title={title} />
      <div className="tp-panel-scroll tp-panel-center">
        {illustration}
        <p className="tp-select-copy">
          <em>Select</em> a model from Assets on the right or <em>upload</em> your own for{' '}
          <strong>{action}</strong>
        </p>
        <button type="button" className="tp-upload-btn" data-testid="tp-upload-model-btn">
          <IcUpload size={15} />
          Upload 3D Model
        </button>
        {extra}
      </div>
      {footer !== undefined ? <div className="tp-panel-foot">{footer}</div> : null}
    </>
  );
}

function SegmentPanel(): JSX.Element {
  return (
    <SelectUploadPanel
      icon={<IcSegment size={17} />}
      title="Segmentation"
      action="Part Segmentation"
      illustration={<SegmentIllustration />}
      extra={
        <div className="tp-unavail">
          <div className="tp-unavail-title">Unavailable for</div>
          <div className="tp-unavail-cards">
            <div className="tp-unavail-card">
              <span className="tp-unavail-x">✕</span>
              <QuadThumb />
              <span>Quad models</span>
            </div>
            <div className="tp-unavail-card">
              <span className="tp-unavail-x">✕</span>
              <RiggedThumb />
              <span>Rigged models</span>
            </div>
          </div>
        </div>
      }
      footer={
        <GenerateButton label="Start Segmenting" cost={40} disabled crown testid="tp-segment-btn" />
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
      {tool === 'fillparts' ? (
        <SelectUploadPanel
          icon={<IcCube size={17} />}
          title="Fill Parts"
          action="Part Filling"
          illustration={<SegmentIllustration />}
          footer={<GenerateButton label="Start Filling" cost={20} disabled crown />}
        />
      ) : null}
      {tool === 'retopo' ? (
        <SelectUploadPanel
          icon={<IcRetopo size={17} />}
          title="Retopology"
          action="Retopology"
          illustration={<RetopoIllustration />}
        />
      ) : null}
      {tool === 'texture' ? (
        <SelectUploadPanel
          icon={<IcTexture size={17} />}
          title="3D Model Texture Generator"
          action="Texture Generation"
          illustration={<TextureIllustration />}
        />
      ) : null}
      {tool === 'edit' ? (
        <SelectUploadPanel
          icon={<IcPencil size={17} />}
          title="Texture Edit"
          action="Texture Editing"
          illustration={<TextureIllustration />}
        />
      ) : null}
      {tool === 'upscale' ? (
        <SelectUploadPanel
          icon={<IcUpscale size={17} />}
          title="Texture Upscale"
          action="Texture Upscaling"
          illustration={<TextureIllustration />}
        />
      ) : null}
      {tool === 'pbr' ? (
        <SelectUploadPanel
          icon={<IcPbr size={17} />}
          title="PBR Maps"
          action="PBR Map Generation"
          illustration={<TextureIllustration />}
        />
      ) : null}
      {tool === 'animate' ? <AnimatePanel /> : null}
    </section>
  );
}
