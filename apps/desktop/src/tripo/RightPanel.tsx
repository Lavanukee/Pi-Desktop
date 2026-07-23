/**
 * Right panel — Assets | Property tabs.
 *  - Assets: upgrade banner, view/favorites/filter row + Manage mode, the
 *    asset grid (Upload card, generating/queued progress cards, ⓘ info
 *    popovers, rig badge, selection ring). Clicking a card loads it into the
 *    viewer (local state only).
 *  - Property: the Hierarchy tree (Armature ▸ Root ▸ tripo_node…) with eye
 *    visibility toggles and per-row “…” menus, exactly as the reference.
 */
import type { JSX } from 'react';
import { TRIPO_ASSETS, type TripoAsset } from './data';
import {
  IcArmature,
  IcBoxNode,
  IcCaretSmall,
  IcDots,
  IcEye,
  IcEyeOff,
  IcFilter,
  IcGrid4,
  IcInfo,
  IcLayers,
  IcManage,
  IcRig,
  IcRootNode,
  IcStar,
  IcTrash,
  IcUpload,
} from './icons';
import { MenuAnchor, MenuItem } from './primitives';
import { useTripoStore } from './store';
import { AssetThumb } from './thumbs';

// ── assets tab ────────────────────────────────────────────────────────────

function UpgradeBanner(): JSX.Element {
  return (
    <div className="tp-upgrade-banner" data-testid="tp-upgrade-banner">
      <p>
        Upgrade to unlock <strong>Unlimited Model Downloads, Ultra Mesh Quality</strong> and other
        premium features! Save up to <strong>50%</strong>
      </p>
      <button type="button" className="tp-upgrade-cta">
        Upgrade
      </button>
    </div>
  );
}

function AssetCard({ asset }: { readonly asset: TripoAsset }): JSX.Element {
  const selected = useTripoStore((s) => s.selectedAssetId) === asset.id;
  const manageMode = useTripoStore((s) => s.manageMode);
  const checked = useTripoStore((s) => s.checkedAssets).includes(asset.id);
  const loadAsset = useTripoStore((s) => s.loadAsset);
  const toggleList = useTripoStore((s) => s.toggleList);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const busy = asset.progress !== undefined || asset.queued === true;

  return (
    <div
      className="tp-asset-card"
      data-selected={selected}
      data-busy={busy}
      data-testid={`tp-asset-${asset.id}`}
    >
      <button
        type="button"
        className="tp-asset-hit"
        aria-label={asset.name}
        onClick={() => {
          if (manageMode) {
            toggleList('checkedAssets', asset.id);
          } else if (!busy) {
            loadAsset(asset.id);
          }
        }}
      >
        <AssetThumb art={asset.art} />
      </button>

      {asset.rigged === true ? (
        <span className="tp-asset-rig" title="Rigged">
          <IcRig size={15} />
        </span>
      ) : null}

      {manageMode ? (
        <span className="tp-asset-checkbox" data-checked={checked}>
          {checked ? '✓' : ''}
        </span>
      ) : (
        <MenuAnchor
          id={`assetinfo-${asset.id}`}
          placement="bottom-start"
          className="tp-asset-info-anchor"
          trigger={
            <button
              type="button"
              className="tp-asset-info"
              aria-label="Asset info"
              data-testid={`tp-asset-info-${asset.id}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleMenu(`assetinfo-${asset.id}`);
              }}
            >
              <IcInfo size={13} />
            </button>
          }
          menu={
            <div className="tp-asset-info-pop">
              <div className="tp-asset-info-name">{asset.name}</div>
              <div className="tp-asset-info-row">
                <span>Created</span>
                <span>{asset.created}</span>
              </div>
              <div className="tp-asset-info-row">
                <span>Faces</span>
                <span>{asset.faces > 0 ? asset.faces.toLocaleString() : '—'}</span>
              </div>
              <div className="tp-asset-info-row">
                <span>Vertices</span>
                <span>{asset.vertices > 0 ? asset.vertices.toLocaleString() : '—'}</span>
              </div>
              <div className="tp-asset-info-row">
                <span>Source</span>
                <span>{asset.source}</span>
              </div>
            </div>
          }
        />
      )}

      {asset.progress !== undefined ? (
        <div className="tp-asset-progress">
          <div className="tp-progress">
            <div className="tp-progress-bar" style={{ width: `${asset.progress}%` }} />
          </div>
          <span className="tp-asset-progress-label">Generating… {asset.progress}%</span>
        </div>
      ) : null}
      {asset.queued === true ? (
        <div className="tp-asset-progress">
          <span className="tp-asset-progress-label">In queue · #2</span>
        </div>
      ) : null}
    </div>
  );
}

function AssetsTab(): JSX.Element {
  const favOnly = useTripoStore((s) => s.favOnly);
  const favorites = useTripoStore((s) => s.favorites);
  const assetFilter = useTripoStore((s) => s.assetFilter);
  const manageMode = useTripoStore((s) => s.manageMode);
  const checkedCount = useTripoStore((s) => s.checkedAssets).length;
  const removed = useTripoStore((s) => s.removedAssets);
  const set = useTripoStore((s) => s.set);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const removeChecked = useTripoStore((s) => s.removeChecked);

  const visible = TRIPO_ASSETS.filter((a) => {
    if (removed.includes(a.id)) return false;
    if (favOnly && !favorites.includes(a.id)) return false;
    if (assetFilter === 'generated' && a.source !== 'generated') return false;
    if (assetFilter === 'uploaded' && a.source !== 'uploaded') return false;
    if (assetFilter === 'rigged' && a.rigged !== true) return false;
    return true;
  });

  return (
    <>
      <UpgradeBanner />
      <div className="tp-assets-toolbar">
        <div className="tp-assets-filters">
          <button
            type="button"
            className="tp-round-btn"
            data-active={!favOnly}
            aria-label="All assets"
            onClick={() => set('favOnly', false)}
          >
            <IcGrid4 size={15} />
          </button>
          <button
            type="button"
            className="tp-round-btn"
            data-active={favOnly}
            aria-label="Favorites"
            data-testid="tp-fav-filter"
            onClick={() => set('favOnly', !favOnly)}
          >
            <IcStar size={15} />
          </button>
          <MenuAnchor
            id="assetfilter"
            trigger={
              <button
                type="button"
                className="tp-round-btn"
                data-active={assetFilter !== 'all'}
                aria-label="Filter"
                data-testid="tp-filter-btn"
                onClick={() => toggleMenu('assetfilter')}
              >
                <IcFilter size={15} />
              </button>
            }
            menu={
              <>
                {(
                  [
                    ['all', 'All types'],
                    ['generated', 'Generated'],
                    ['uploaded', 'Uploaded'],
                    ['rigged', 'Rigged'],
                  ] as const
                ).map(([id, label]) => (
                  <MenuItem
                    key={id}
                    label={label}
                    checked={assetFilter === id}
                    testid={`tp-filter-${id}`}
                    onClick={() => {
                      set('assetFilter', id);
                      closeMenus();
                    }}
                  />
                ))}
              </>
            }
          />
        </div>
        <button
          type="button"
          className="tp-manage-btn"
          data-active={manageMode}
          data-testid="tp-manage-btn"
          onClick={() => {
            set('manageMode', !manageMode);
            set('checkedAssets', []);
          }}
        >
          <IcManage size={14} />
          {manageMode ? 'Done' : 'Manage'}
        </button>
      </div>

      <div className="tp-asset-grid" data-testid="tp-asset-grid">
        <button type="button" className="tp-upload-card" data-testid="tp-upload-card">
          <span className="tp-upload-orb">
            <IcUpload size={16} />
          </span>
          <span className="tp-upload-card-title">Upload 3D Model</span>
          <span className="tp-upload-card-sub">
            OBJ, FBX, STL, GLB
            <br />
            Size ≤150MB
          </span>
        </button>
        {visible.map((a) => (
          <AssetCard key={a.id} asset={a} />
        ))}
      </div>

      {manageMode ? (
        <div className="tp-manage-bar" data-testid="tp-manage-bar">
          <span>{checkedCount} selected</span>
          <div className="tp-manage-actions">
            <button type="button" className="tp-manage-action" disabled={checkedCount === 0}>
              <IcUpload size={14} />
              Download
            </button>
            <button
              type="button"
              className="tp-manage-action tp-manage-danger"
              disabled={checkedCount === 0}
              data-testid="tp-manage-delete"
              onClick={removeChecked}
            >
              <IcTrash size={14} />
              Delete
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ── property tab ──────────────────────────────────────────────────────────

interface HierRow {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly icon: JSX.Element;
  readonly hasChildren: boolean;
  readonly parent?: string;
}
const HIERARCHY: readonly HierRow[] = [
  {
    id: 'armature',
    label: 'Armature',
    depth: 0,
    icon: <IcArmature size={15} />,
    hasChildren: true,
  },
  {
    id: 'root',
    label: 'Root',
    depth: 1,
    icon: <IcRootNode size={15} />,
    hasChildren: true,
    parent: 'armature',
  },
  {
    id: 'tripo_node_711b6583',
    label: 'tripo_node_711b6583…',
    depth: 2,
    icon: <IcBoxNode size={15} />,
    hasChildren: false,
    parent: 'root',
  },
];

function HierarchyRow({ row }: { readonly row: HierRow }): JSX.Element {
  const collapsed = useTripoStore((s) => s.hierarchyCollapsed);
  const hidden = useTripoStore((s) => s.hiddenNodes).includes(row.id);
  const selected = useTripoStore((s) => s.selectedNode) === row.id;
  const toggleList = useTripoStore((s) => s.toggleList);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const set = useTripoStore((s) => s.set);

  const isCollapsed = collapsed.includes(row.id);

  return (
    <div
      className="tp-hier-row"
      data-selected={selected}
      data-testid={`tp-hier-${row.id}`}
      style={{ paddingLeft: `${10 + row.depth * 18}px` }}
    >
      {row.hasChildren ? (
        <button
          type="button"
          className="tp-hier-caret"
          data-collapsed={isCollapsed}
          aria-label="Toggle children"
          onClick={() => toggleList('hierarchyCollapsed', row.id)}
        >
          <IcCaretSmall size={11} />
        </button>
      ) : (
        <span className="tp-hier-caret tp-hier-caret-empty" />
      )}
      <button type="button" className="tp-hier-main" onClick={() => set('selectedNode', row.id)}>
        <span className="tp-hier-icon">{row.icon}</span>
        <span className="tp-hier-label">{row.label}</span>
      </button>
      <button
        type="button"
        className="tp-hier-tool"
        aria-label={hidden ? 'Show' : 'Hide'}
        data-testid={`tp-hier-eye-${row.id}`}
        onClick={() => {
          toggleList('hiddenNodes', row.id);
          // The mesh node's eye drives the actual viewer mesh visibility.
          if (row.id === 'tripo_node_711b6583') {
            set('meshVisible', hidden);
          }
        }}
      >
        {hidden ? <IcEyeOff size={14} /> : <IcEye size={14} />}
      </button>
      <MenuAnchor
        id={`hier-${row.id}`}
        placement="bottom-end"
        trigger={
          <button
            type="button"
            className="tp-hier-tool"
            aria-label="Node menu"
            data-testid={`tp-hier-menu-${row.id}`}
            onClick={() => toggleMenu(`hier-${row.id}`)}
          >
            <IcDots size={14} />
          </button>
        }
        menu={
          <>
            <MenuItem label="Rename" onClick={closeMenus} />
            <MenuItem label="Duplicate" onClick={closeMenus} />
            <MenuItem label="Isolate" onClick={closeMenus} />
            <MenuItem label="Delete" danger onClick={closeMenus} />
          </>
        }
      />
    </div>
  );
}

function PropertyTab(): JSX.Element {
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const collapsed = useTripoStore((s) => s.hierarchyCollapsed);

  if (loadedAssetId === null) {
    return (
      <div className="tp-property-empty" data-testid="tp-property-empty">
        <IcBoxNode size={26} />
        <p>Select a model from Assets to inspect its hierarchy</p>
      </div>
    );
  }

  const rows = HIERARCHY.filter((r) => {
    if (r.parent === undefined) return true;
    // Hide descendants of any collapsed ancestor.
    let p: string | undefined = r.parent;
    while (p !== undefined) {
      if (collapsed.includes(p)) return false;
      p = HIERARCHY.find((h) => h.id === p)?.parent;
    }
    return true;
  });

  return (
    <>
      <UpgradeBanner />
      <div className="tp-section-title tp-hier-title">Hierarchy</div>
      <div className="tp-hierarchy" data-testid="tp-hierarchy">
        {rows.map((r) => (
          <HierarchyRow key={r.id} row={r} />
        ))}
      </div>
    </>
  );
}

// ── the panel ─────────────────────────────────────────────────────────────

export function RightPanel(): JSX.Element {
  const rightTab = useTripoStore((s) => s.rightTab);
  const set = useTripoStore((s) => s.set);

  return (
    <aside className="tp-rightpanel" data-testid="tp-rightpanel">
      <div className="tp-right-tabs">
        <button
          type="button"
          className="tp-right-tab"
          data-active={rightTab === 'assets'}
          data-testid="tp-tab-assets"
          onClick={() => set('rightTab', 'assets')}
        >
          <IcGrid4 size={15} />
          Assets
        </button>
        <button
          type="button"
          className="tp-right-tab"
          data-active={rightTab === 'property'}
          data-testid="tp-tab-property"
          onClick={() => set('rightTab', 'property')}
        >
          <IcLayers size={15} />
          Property
        </button>
      </div>
      <div className="tp-right-body">{rightTab === 'assets' ? <AssetsTab /> : <PropertyTab />}</div>
    </aside>
  );
}
