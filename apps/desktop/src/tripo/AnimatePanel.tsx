/**
 * Animate panel — 3D Rigging & Animation: AI model dropdown, glowing Retry,
 * Skeleton toggle, Model Type row, preset search + All/Basic/Interactive
 * filter pills, and the mannequin preset grid (selected pose gets the check
 * badge, exactly like the reference).
 */
import type { JSX } from 'react';
import { ANIM_MODELS, TRIPO_ANIMS } from './data';
import { IcAnimate, IcBolt, IcCaretSmall, IcCheck, IcDog, IcSearch } from './icons';
import { MenuAnchor, MenuItem, Segmented, Toggle } from './primitives';
import { useTripoStore } from './store';
import { Mannequin } from './thumbs';

function AnimModelSelect(): JSX.Element {
  const animModel = useTripoStore((s) => s.animModel);
  const openMenu = useTripoStore((s) => s.openMenu);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const set = useTripoStore((s) => s.set);
  const current = ANIM_MODELS.find((m) => m.id === animModel) ?? ANIM_MODELS[0];
  if (current === undefined) return <div />;

  return (
    <div className="tp-section">
      <div className="tp-section-title">AI Model</div>
      <MenuAnchor
        id="animmodel"
        className="tp-anchor-block"
        trigger={
          <button
            type="button"
            className="tp-model-select"
            data-testid="tp-animmodel-btn"
            onClick={() => toggleMenu('animmodel')}
          >
            <span className="tp-model-avatar tp-model-avatar-anim">
              <IcDog size={16} />
            </span>
            <span className="tp-model-titles">
              <span className="tp-model-name">{current.label}</span>
            </span>
            <span className="tp-model-caret" data-open={openMenu === 'animmodel'}>
              <IcCaretSmall size={13} />
            </span>
          </button>
        }
        menu={ANIM_MODELS.map((m) => (
          <MenuItem
            key={m.id}
            label={m.label}
            hint={m.hint}
            checked={m.id === animModel}
            onClick={() => {
              set('animModel', m.id);
              closeMenus();
            }}
          />
        ))}
      />
    </div>
  );
}

export function AnimatePanel(): JSX.Element {
  const skeleton = useTripoStore((s) => s.skeleton);
  const animFilter = useTripoStore((s) => s.animFilter);
  const animSearch = useTripoStore((s) => s.animSearch);
  const selectedAnim = useTripoStore((s) => s.selectedAnim);
  const set = useTripoStore((s) => s.set);
  const runStage = useTripoStore((s) => s.runStage);

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
        3D Rigging &amp; Animation
      </div>
      <div className="tp-panel-scroll">
        <AnimModelSelect />
        <button type="button" className="tp-retry-btn" data-testid="tp-retry-btn">
          Retry
          <span className="tp-cost tp-cost-dark">
            <IcBolt size={13} />
            20
          </span>
        </button>

        {/* Sample-asset-backed: overlays the bundled hero's real three.js
         * Skeleton (bind pose). NOT a live SkinTokens run. */}
        <button
          type="button"
          className="tp-retry-btn"
          data-testid="tp-rig-btn"
          onClick={() => {
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
        <div className="tp-setting-row tp-row-plain">
          <span className="tp-setting-label">Model Type</span>
          <span className="tp-value-muted">Humanoid</span>
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
