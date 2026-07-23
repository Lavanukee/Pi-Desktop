/**
 * Animate panel — rigging (SkinTokens) + animation (ARDY): the rig button,
 * Skeleton toggle, preset search + All/Basic/Interactive filter pills, and the
 * pose preset grid. Sample-asset-backed: rig overlays the bundled hero's real
 * three.js Skeleton; presets play baked clips on its SkinnedMesh — labeled with
 * the intended real engines, not live runs yet.
 */
import type { JSX } from 'react';
import { ANIM_MODEL, RIG_MODEL, TRIPO_ANIMS } from './data';
import { IcAnimate, IcCheck, IcSearch } from './icons';
import { Segmented, Toggle } from './primitives';
import { HERO_ASSET_ID, useTripoStore } from './store';
import { Mannequin } from './thumbs';

export function AnimatePanel(): JSX.Element {
  const skeleton = useTripoStore((s) => s.skeleton);
  const animFilter = useTripoStore((s) => s.animFilter);
  const animSearch = useTripoStore((s) => s.animSearch);
  const selectedAnim = useTripoStore((s) => s.selectedAnim);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const set = useTripoStore((s) => s.set);
  const runStage = useTripoStore((s) => s.runStage);
  const loadAsset = useTripoStore((s) => s.loadAsset);
  // Rig/animate run on the generated sample (an arbitrary imported mesh has no
  // skeleton until a live SkinTokens engine is wired) — flag that honestly.
  const importedLoaded = loadedAssetId !== null && loadedAssetId !== HERO_ASSET_ID;

  const visible = TRIPO_ANIMS.filter(
    (a) =>
      (animFilter === 'all' || a.kind === animFilter) &&
      a.id.toLowerCase().includes(animSearch.toLowerCase()),
  );

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

        {importedLoaded ? (
          <p className="tp-select-copy" data-testid="tp-rig-imported-note">
            Rigging an imported model needs the live {RIG_MODEL} engine — these controls drive the
            generated sample.
          </p>
        ) : null}

        {/* Sample-asset-backed: overlays the bundled hero's real three.js
         * Skeleton (bind pose). NOT a live SkinTokens run. */}
        <button
          type="button"
          className="tp-retry-btn"
          data-testid="tp-rig-btn"
          onClick={() => {
            // Rigging drives the generated sample; if an imported model is in
            // the viewport, swap back to the sample first (see the note above).
            if (importedLoaded) loadAsset(HERO_ASSET_ID);
            set('skeleton', true);
            runStage('rig');
          }}
        >
          Generate Rig &amp; Skeleton
        </button>

        <div className="tp-setting-row tp-row-plain">
          <span className="tp-setting-label">Skeleton</span>
          <Toggle on={skeleton} onChange={(v) => set('skeleton', v)} testid="tp-skeleton-toggle" />
        </div>

        <div className="tp-search">
          <IcSearch size={15} />
          <input
            type="text"
            placeholder="Search"
            value={animSearch}
            data-testid="tp-anim-search"
            onChange={(e) => set('animSearch', e.target.value)}
          />
        </div>

        <Segmented
          testid="tp-anim-filter"
          size="sm"
          options={[
            { id: 'all', label: 'All' },
            { id: 'basic', label: 'Basic' },
            { id: 'interactive', label: 'Interactive' },
          ]}
          value={animFilter}
          onChange={(v) => set('animFilter', v)}
        />

        <div className="tp-anim-grid" data-testid="tp-anim-grid">
          {visible.map((a) => (
            <button
              key={a.id}
              type="button"
              className="tp-anim-card"
              data-active={selectedAnim === a.id}
              data-testid={`tp-anim-${a.id}`}
              onClick={() => {
                // Sample-asset-backed: plays a baked skeletal clip on the hero
                // SkinnedMesh (mapped to idle/wave/coil). NOT a live ARDY run.
                if (importedLoaded) loadAsset(HERO_ASSET_ID);
                set('selectedAnim', a.id);
                runStage('animate');
              }}
            >
              {selectedAnim === a.id ? (
                <span className="tp-anim-check">
                  <IcCheck size={11} />
                </span>
              ) : null}
              <Mannequin pose={a.id} />
              <span className="tp-anim-name">{a.id}</span>
            </button>
          ))}
          {visible.length === 0 ? <div className="tp-anim-empty">No presets match</div> : null}
        </div>
      </div>
    </>
  );
}
