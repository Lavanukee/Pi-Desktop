/**
 * Animate panel — the ARDY control deck. Not just "generate rig": it authors
 * MOTIONS (bundled presets + natural-language ARDY clips) and composes them
 * into an animation state machine for MOTION MATCHING (the graph opens over the
 * viewport — see BlendGraph). Sections: rig the character (SkinTokens), describe
 * a motion (ARDY), the motion library (click a motion to drop it into the
 * machine, hover to preview it on the humanoid dummy), the driving parameters,
 * and the state-machine launcher + JSON export.
 *
 * Design-backed until the live rig/ARDY engines are wired: rigging overlays the
 * loaded model's skeleton, motion previews play on the bundled dummy, and the
 * authored graph is fully real and exportable.
 */
import type { JSX } from 'react';
import { ANIM_PREVIEWS } from './assets/anim-previews';
import { ANIM_MODEL, RIG_MODEL } from './data';
import { IcAnimate, IcBolt, IcPlus, IcRig, IcSearch, IcSparkles, IcTrash } from './icons';
import { Segmented, Toggle } from './primitives';
import { useTripoStore } from './store';

/** Preset preview: a real skeletal-animation video on the humanoid dummy —
 * the mid-motion poster by default, playing on hover. */
function AnimPreviewCard({ preset }: { readonly preset: string | undefined }): JSX.Element | null {
  const preview = preset !== undefined ? ANIM_PREVIEWS[preset] : undefined;
  if (preview === undefined)
    return (
      <div className="tp-anim-video tp-anim-video-none">
        <IcBolt size={18} />
      </div>
    );
  return (
    // biome-ignore lint/a11y/useMediaCaption: silent motion previews of animation presets — there is no speech to caption
    <video
      className="tp-anim-video"
      src={preview.video}
      poster={preview.poster}
      muted
      loop
      playsInline
      preload="none"
      onMouseEnter={(e) => {
        void e.currentTarget.play().catch(() => {});
      }}
      onMouseLeave={(e) => {
        e.currentTarget.pause();
        e.currentTarget.currentTime = 0;
      }}
    />
  );
}

function ParametersSection(): JSX.Element {
  const params = useTripoStore((s) => s.blendParams);
  const addParam = useTripoStore((s) => s.addBlendParam);
  const updateParam = useTripoStore((s) => s.updateBlendParam);
  const removeParam = useTripoStore((s) => s.removeBlendParam);

  return (
    <div className="tp-params" data-testid="tp-params">
      <div className="tp-section-title">Parameters</div>
      <p className="tp-select-copy">The values a game feeds the machine to pick + blend motions.</p>
      {params.map((p) => (
        <div className="tp-param-row" key={p.id}>
          <input
            type="text"
            className="tp-textinput tp-param-name"
            value={p.name}
            aria-label="Parameter name"
            onChange={(e) => updateParam(p.id, { name: e.target.value })}
          />
          <Segmented
            size="sm"
            options={[
              { id: 'float', label: 'float' },
              { id: 'bool', label: 'bool' },
            ]}
            value={p.type}
            onChange={(v) => updateParam(p.id, { type: v, value: 0 })}
          />
          <button
            type="button"
            className="tp-param-del"
            aria-label={`Remove ${p.name}`}
            onClick={() => removeParam(p.id)}
          >
            <IcTrash size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="tp-upload-btn" data-testid="tp-add-param" onClick={addParam}>
        <IcPlus size={14} />
        Add parameter
      </button>
    </div>
  );
}

export function AnimatePanel(): JSX.Element {
  const skeleton = useTripoStore((s) => s.skeleton);
  const animSearch = useTripoStore((s) => s.animSearch);
  const motionPrompt = useTripoStore((s) => s.motionPrompt);
  const motions = useTripoStore((s) => s.motionLibrary);
  const states = useTripoStore((s) => s.blendStates);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const set = useTripoStore((s) => s.set);
  const runStage = useTripoStore((s) => s.runStage);
  const generateMotion = useTripoStore((s) => s.generateMotion);
  const addBlendState = useTripoStore((s) => s.addBlendState);
  const hasModel = loadedAssetId !== null;

  const visible = motions.filter((m) => m.name.toLowerCase().includes(animSearch.toLowerCase()));

  const rig = () => {
    if (!hasModel) return;
    set('skeleton', true);
    runStage('rig');
    // The rigged model gains an armature in the hierarchy.
    useTripoStore.setState((s) => ({
      assets: s.assets.map((a) => (a.id === s.loadedAssetId ? { ...a, rigged: true } : a)),
    }));
  };

  return (
    <>
      <div className="tp-panel-header">
        <span className="tp-panel-header-icon">
          <IcAnimate size={17} />
        </span>
        Rigging &amp; Animation
      </div>
      <div className="tp-panel-scroll">
        <div className="tp-engine-row" data-testid="tp-rig-engine-row">
          <span className="tp-field-label">Rigging</span>
          <span className="tp-engine-name">{RIG_MODEL}</span>
        </div>
        <div className="tp-engine-row">
          <span className="tp-field-label">Animation</span>
          <span className="tp-engine-name">{ANIM_MODEL}</span>
        </div>

        {/* ── rig ─────────────────────────────────────────────────────── */}
        {!hasModel ? (
          <p className="tp-select-copy" data-testid="tp-rig-imported-note">
            Load a model (generate or import one) to rig it with {RIG_MODEL}.
          </p>
        ) : null}
        <button
          type="button"
          className="tp-retry-btn"
          data-testid="tp-rig-btn"
          disabled={!hasModel}
          onClick={rig}
        >
          <IcRig size={15} />
          Auto-Rig with {RIG_MODEL}
        </button>
        <div className="tp-setting-row tp-row-plain">
          <span className="tp-setting-label">Skeleton</span>
          <Toggle on={skeleton} onChange={(v) => set('skeleton', v)} testid="tp-skeleton-toggle" />
        </div>

        {/* ── generate a motion (ARDY, natural language) ──────────────── */}
        <div className="tp-section-title">Describe a motion ({ANIM_MODEL})</div>
        <div className="tp-card tp-card-pad">
          <textarea
            className="tp-prompt"
            data-testid="tp-motion-prompt"
            placeholder="Describe an action… e.g. a cautious crouch-walk that breaks into a sprint, then a dodge-roll left"
            rows={3}
            value={motionPrompt}
            onChange={(e) => set('motionPrompt', e.target.value)}
          />
        </div>
        <button
          type="button"
          className="tp-generate-btn"
          data-testid="tp-generate-motion"
          disabled={motionPrompt.trim().length === 0}
          onClick={generateMotion}
        >
          <IcSparkles size={15} />
          Generate Motion
        </button>

        {/* ── motion library (click a motion → drop it into the machine) ─ */}
        <div className="tp-section-title">Motion library</div>
        <p className="tp-select-copy">
          Click a motion to add it to the state machine · hover to preview.
        </p>
        <div className="tp-search">
          <IcSearch size={15} />
          <input
            type="text"
            placeholder="Search motions"
            value={animSearch}
            data-testid="tp-anim-search"
            onChange={(e) => set('animSearch', e.target.value)}
          />
        </div>
        <div className="tp-anim-grid" data-testid="tp-anim-grid">
          {visible.map((m) => (
            <button
              key={m.id}
              type="button"
              className="tp-anim-card"
              data-generated={m.kind === 'generated'}
              data-testid={`tp-motion-${m.id}`}
              title={m.prompt ?? m.name}
              onClick={() => addBlendState(m.id)}
            >
              <span className="tp-anim-add">
                <IcPlus size={11} />
              </span>
              <AnimPreviewCard preset={m.previewId} />
              <span className="tp-anim-name">{m.name}</span>
            </button>
          ))}
          {visible.length === 0 ? <div className="tp-anim-empty">No motions match</div> : null}
        </div>

        {/* ── driving parameters ──────────────────────────────────────── */}
        <ParametersSection />
      </div>

      {/* ── state machine launcher ───────────────────────────────────── */}
      <div className="tp-panel-foot">
        <button
          type="button"
          className="tp-generate-btn"
          data-testid="tp-open-graph"
          onClick={() => set('graphOpen', true)}
        >
          <IcBolt size={15} />
          {states.length === 0
            ? 'Open State Machine'
            : `Open State Machine · ${states.length} states`}
        </button>
      </div>
    </>
  );
}
