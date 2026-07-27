/**
 * Animate panel — rig first, then motion.
 *
 * The gate is deliberate and jedd asked for it explicitly: nothing about motion
 * is visible until the loaded model is ACTUALLY RIGGED, and the animation
 * presets stay hidden unless the rig is humanoid. A state machine over a model
 * with no skeleton is theatre.
 *
 * Flow: Analyse shape → the engine measures whether the mesh reads as humanoid
 * and reports it → we ASK ("humanoid?") instead of guessing → the rig runs and
 * produces a real skinned GLB on the asset's history tree.
 *
 * WHICH RIGGER RUNS IS DECIDED BY THE SHAPE PROBE'S ANSWER (jedd), and the two
 * are not interchangeable:
 *   humanoid  -> a geometric fit to ARDY's exact 27-joint cskel27, which is the
 *                only skeleton the motion stage can drive
 *   anything  -> SkinTokens, which PREDICTS a skeleton per mesh and is the only
 *   else        way to rig an animal or an invented creature at all
 * Routing SkinTokens over everything, as this did before, silently cost every
 * humanoid its ability to animate — MEASURED, it predicted a 15-joint skeleton
 * for a humanoid mesh. So a model that reaches "rigged and humanoid" here is
 * animatable by construction, and needs no further compatibility check.
 *
 * HONEST STATUS of the two named engines:
 *  - Humanoid rigging is a GEOMETRIC fit to NVIDIA ARDY's 27-joint skeleton,
 *    not SkinTokens. NOTE (2026-07-24): this used to say SkinTokens "needs a >=14 GB
 *    NVIDIA GPU … cannot run on this machine at all" — that was WRONG (it
 *    described the upstream CUDA repo, from unexecuted web research).
 *    `mlx-community/SkinTokens-bf16` runs natively on Apple Silicon; wiring it
 *    is tracked work, and it emits a VRoid hierarchy so it needs retargeting to
 *    reach cskel27.
 *  - ARDY motion generation IS wired and runs HERE, on Metal (2026-07-27).
 *    The "Linux + NVIDIA only" note this file used to carry was true of the
 *    upstream repo, not of the port: MEASURED on this Mac, 8s of motion in
 *    ~1s. The clip is written into the rigged GLB itself, so what animates is
 *    the user's own textured character rather than a preview skeleton — the
 *    rig already uses ARDY's exact cskel27, so no retargeting step exists.
 * The panel says so on screen rather than implying otherwise.
 */
import type { JSX } from 'react';
import { ANIM_PREVIEWS } from './assets/anim-previews';
import { ANIM_MODEL, RIG_MODEL } from './data';
import { useGen3dStore } from './gen3d-client';
import { IcAnimate, IcBolt, IcInfo, IcPlus, IcRig, IcSearch, IcSparkles, IcTrash } from './icons';
import { Segmented } from './primitives';
import { currentVersion, useTripoStore } from './store';

/** Preset preview: a real skeletal-animation video on a humanoid dummy — the
 * mid-motion poster by default, playing on hover. These are BUNDLED sample
 * clips, not model output. */
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
        // CSS cannot stop a <video>, so the reduced-motion contract has to be
        // honoured here: under `reduce` the card stays on its poster frame,
        // which is a mid-motion still and still says what the clip is. Every
        // other animation in the studio opts out via the media query in
        // tripo.css; this was the one that could not.
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
      <button type="button" className="tp-btn-quiet" data-testid="tp-add-param" onClick={addParam}>
        <IcPlus size={14} />
        Add parameter
      </button>
    </div>
  );
}

/** The "humanoid?" question — raised by the engine's shape probe, answered by
 * the user. This is the ONLY path to a humanoid rig. */
function HumanoidPrompt({
  diskPath,
  assetId,
  versionId,
}: {
  readonly diskPath: string;
  readonly assetId: string;
  readonly versionId: string;
}): JSX.Element | null {
  const prompt = useTripoStore((s) => s.humanoidPrompt);
  const runStage = useGen3dStore((s) => s.runStage);
  if (prompt === null || prompt.assetId !== assetId) return null;

  const pct = Math.round(prompt.confidence * 100);
  const dismiss = () => useTripoStore.setState({ humanoidPrompt: null });
  const rig = () => {
    dismiss();
    // The verdict travels TWICE, to two different places, and both matter.
    //
    // `humanoid` goes to the ENGINE, where it chooses the rigger: yes fits
    // ARDY's cskel27 so the motion stage can drive the result, no hands the
    // mesh to SkinTokens, which can rig a creature a humanoid template cannot.
    //
    // `knownHumanoid` stays in the UI. The rig job itself may not measure
    // humanoid-ness (SkinTokens predicts a skeleton for any mesh and reports
    // none), and without it the produced version recorded humanoid:false —
    // hiding every motion control behind a rig that had just succeeded and been
    // confirmed humanoid.
    void runStage(
      'rig',
      diskPath,
      { assetId, versionId, op: 'rig' },
      {
        humanoid: prompt.isHumanoid,
        knownHumanoid: prompt.isHumanoid,
      },
    );
  };

  return (
    <div
      className="tp-humanoid-ask"
      data-testid="tp-humanoid-ask"
      data-humanoid={prompt.isHumanoid}
    >
      <div className="tp-humanoid-ask-title">
        {prompt.isHumanoid ? 'This looks humanoid.' : "This doesn't look humanoid."}
      </div>
      <p className="tp-humanoid-ask-body">
        {prompt.isHumanoid ? (
          <>
            Two leg columns and arm span detected ({pct}% confidence). Rig it with the 27-joint
            humanoid skeleton {ANIM_MODEL} expects?
          </>
        ) : (
          <>
            {prompt.reasons.length > 0 ? prompt.reasons.join('; ') : 'no humanoid structure found'}.
            A humanoid rig fitted to a non-humanoid mesh puts bones where there is no body — and the
            animation presets will stay hidden either way.
          </>
        )}
      </p>
      <div className="tp-humanoid-ask-actions">
        <button
          type="button"
          className="tp-btn-primary"
          data-testid="tp-humanoid-confirm"
          onClick={rig}
        >
          <IcRig size={15} />
          {prompt.isHumanoid ? 'Rig as humanoid' : 'Rig anyway'}
        </button>
        <button
          type="button"
          className="tp-ghost-btn"
          data-testid="tp-humanoid-cancel"
          onClick={dismiss}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function AnimatePanel(): JSX.Element {
  const animSearch = useTripoStore((s) => s.animSearch);
  const motionPrompt = useTripoStore((s) => s.motionPrompt);
  const motionSeconds = useTripoStore((s) => s.motionSeconds);
  const motions = useTripoStore((s) => s.motionLibrary);
  const states = useTripoStore((s) => s.blendStates);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const assets = useTripoStore((s) => s.assets);
  const set = useTripoStore((s) => s.set);
  const addBlendState = useTripoStore((s) => s.addBlendState);

  const engineReady = useGen3dStore((s) => s.engineReady);
  const models = useGen3dStore((s) => s.models);
  const job = useGen3dStore((s) => s.job);
  const runStage = useGen3dStore((s) => s.runStage);

  const asset = assets.find((a) => a.id === loadedAssetId);
  const version = asset === undefined ? undefined : currentVersion(asset);
  const hasModel = asset !== undefined && version?.diskPath !== undefined;
  const rigged = version?.rigged === true;
  const humanoid = version?.humanoid === true;
  const rigInstalled =
    engineReady && models.find((m) => m.id === 'humanoid-rig')?.installed === true;
  const busy = job !== null && !job.done && job.stage === 'rig';
  const motionBusy = job !== null && !job.done && job.stage === 'motion';
  const motionInstalled =
    engineReady && models.find((m) => m.id === 'ardy-motion')?.installed === true;
  /*
   * Motion needs no separate compatibility check any more: answering "yes,
   * humanoid" is what routes the rig to the cskel27 fitter, which is ARDY's
   * exact hierarchy. A model that reached `rigged && humanoid` is therefore
   * animatable by construction.
   *
   * A non-humanoid keeps SkinTokens' predicted skeleton — which is the point:
   * it can rig a creature no humanoid template fits — and the motion section
   * stays hidden for it, because ARDY only generates human motion.
   */

  const runMotion = () => {
    if (asset === undefined || version?.diskPath === undefined) return;
    // The RIGGED model is the input: the clip is written into it, so the result
    // keeps this character's mesh, skin weights and texture.
    void runStage(
      'motion',
      version.diskPath,
      { assetId: asset.id, versionId: version.id, op: 'motion' },
      // knownHumanoid is not in doubt here: this button only exists on a rig
      // that measured humanoid. Without it the ANIMATED version records
      // humanoid:false and the motion controls disappear after the first clip.
      { prompt: motionPrompt.trim(), seconds: motionSeconds, knownHumanoid: true },
    );
  };

  const visible = motions.filter((m) => m.name.toLowerCase().includes(animSearch.toLowerCase()));

  const analyse = () => {
    if (asset === undefined || version?.diskPath === undefined) return;
    void runStage(
      'rig',
      version.diskPath,
      { assetId: asset.id, versionId: version.id, op: 'rig' },
      { probeOnly: true },
    );
  };

  return (
    <>
      <div className="tp-panel-header">
        <span className="tp-panel-header-icon">
          <IcAnimate size={17} />
        </span>
        Rigging &amp; Animation
      </div>
      <div className="tp-panel-scroll pd-scroll">
        <div className="tp-engine-row" data-testid="tp-rig-engine-row">
          <span className="tp-field-label">Rigging</span>
          <span className="tp-engine-name">{RIG_MODEL}</span>
        </div>

        {/* ── rig ─────────────────────────────────────────────────────── */}
        {!hasModel ? (
          <p className="tp-select-copy" data-testid="tp-rig-imported-note">
            Load a model (generate, import, or pick one from Assets) to rig it.
          </p>
        ) : null}

        {hasModel && !rigged ? (
          <>
            {!rigInstalled ? (
              <p className="tp-stage-warn" data-testid="tp-rig-unavailable">
                The 3D engine runtime isn't ready yet, so rigging can't run. Open the download panel
                to finish engine setup.
              </p>
            ) : null}
            <button
              type="button"
              className="tp-btn-tonal"
              data-testid="tp-rig-btn"
              disabled={!rigInstalled || busy}
              onClick={analyse}
            >
              <IcRig size={15} />
              {busy ? 'Analysing shape…' : 'Analyse shape & rig'}
            </button>
            {asset !== undefined && version?.diskPath !== undefined ? (
              <HumanoidPrompt
                diskPath={version.diskPath}
                assetId={asset.id}
                versionId={version.id}
              />
            ) : null}
          </>
        ) : null}

        {rigged ? (
          <div className="tp-rig-status" data-testid="tp-rig-status" data-humanoid={humanoid}>
            <IcRig size={15} />
            <span>
              {/* No joint count and no "humanoid skeleton" claim: SkinTokens
                  PREDICTS a skeleton per model rather than fitting a fixed
                  template, so the old "27-joint ARDY humanoid" line was simply
                  false over an 11-joint predicted rig. State what is known. */}
              Rigged · {RIG_MODEL} skeleton
              {humanoid ? ' · humanoid proportions' : ''}
            </span>
          </div>
        ) : null}

        {/* Everything below is gated on a REAL rig. */}
        {rigged && humanoid ? (
          <>
            <div className="tp-section-title">Describe a motion ({ANIM_MODEL})</div>
            {!motionInstalled ? (
              <div className="tp-notice" data-testid="tp-ardy-unavailable">
                <IcInfo size={14} />
                <span>
                  {ANIM_MODEL} isn't downloaded yet. Open the download panel to add it — most of its
                  size is a text encoder that runs once per new wording.
                </span>
              </div>
            ) : null}
            <textarea
              className="tp-prompt"
              rows={2}
              placeholder="A person walks forward, then waves."
              value={motionPrompt}
              data-testid="tp-motion-prompt"
              onChange={(e) => set('motionPrompt', e.target.value)}
            />
            <div className="tp-field-row" data-testid="tp-motion-seconds">
              <span className="tp-field-label">Length</span>
              <Segmented
                value={String(motionSeconds)}
                options={[
                  { id: '4', label: '4s' },
                  { id: '8', label: '8s' },
                  { id: '15', label: '15s' },
                ]}
                onChange={(v) => set('motionSeconds', Number(v))}
              />
            </div>
            <button
              type="button"
              className="tp-btn-primary"
              data-testid="tp-generate-motion"
              disabled={!motionInstalled || motionBusy || motionPrompt.trim() === ''}
              onClick={runMotion}
            >
              <IcSparkles size={15} />
              {motionBusy ? 'Generating motion…' : 'Generate Motion'}
            </button>
            {/* The FIRST use of a new wording loads a 16 GB text encoder; every
                later use of the same words skips it entirely. Saying so up
                front is the difference between "slow" and "broken". */}
            <p className="tp-select-copy" data-testid="tp-motion-note">
              Runs on this Mac — about a second of compute for {motionSeconds}s of animation. A
              wording used before starts immediately; a brand-new one spends a couple of minutes
              reading the prompt first.
            </p>

            {/* ── motion library (click a motion → drop it into the machine) ─ */}
            <div className="tp-section-title">Motion library</div>
            <p className="tp-select-copy">
              Bundled sample clips. Click one to add it to the state machine · hover to preview.
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

            <ParametersSection />
          </>
        ) : null}

        {rigged && !humanoid ? (
          <p className="tp-select-copy" data-testid="tp-nonhumanoid-note">
            Animation presets are humanoid clips, so they're hidden for this model — retargeting
            them onto a non-humanoid skeleton would only produce nonsense.
          </p>
        ) : null}
      </div>

      {/* ── state machine launcher: only once there is a humanoid rig ─── */}
      {rigged && humanoid ? (
        <div className="tp-panel-foot">
          <button
            type="button"
            className="tp-btn-primary"
            data-testid="tp-open-graph"
            onClick={() => set('graphOpen', true)}
          >
            <IcBolt size={15} />
            {states.length === 0
              ? 'Open State Machine'
              : `Open State Machine · ${states.length} states`}
          </button>
        </div>
      ) : null}
    </>
  );
}
