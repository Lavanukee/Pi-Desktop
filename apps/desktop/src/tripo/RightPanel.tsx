/**
 * Right panel — Assets | Property tabs.
 *  - Assets: filter + Manage mode, the Upload card (real file picker), and the
 *    asset grid. Every thumbnail is a REAL rendered preview captured by the
 *    viewer (never icon artwork); a just-added asset shows a neutral
 *    placeholder until its first frame is captured. Clicking a card loads it
 *    into the viewer. No promos, no favorites.
 *  - Property: the hierarchy tree with eye visibility toggles.
 */
import type { JSX } from 'react';
import { useRef } from 'react';
import {
  IcArmature,
  IcBoxNode,
  IcCheck,
  IcCaretSmall,
  IcCube,
  IcDots,
  IcEye,
  IcEyeOff,
  IcFilter,
  IcGrid4,
  IcHistory,
  IcInfo,
  IcLayers,
  IcManage,
  IcRig,
  IcRootNode,
  IcTrash,
  IcUpload,
} from './icons';
import { MenuAnchor, MenuItem } from './primitives';
import {
  type AssetVersion,
  currentVersion,
  hasSiblings,
  type StudioAsset,
  type TripoOp,
  useTripoStore,
  versionDepth,
} from './store';
import { importModelFile, saveAssetTree } from './viewer-io';

// ── assets tab ────────────────────────────────────────────────────────────

function AssetCard({ asset }: { readonly asset: StudioAsset }): JSX.Element {
  const selected = useTripoStore((s) => s.selectedAssetId) === asset.id;
  const manageMode = useTripoStore((s) => s.manageMode);
  const checked = useTripoStore((s) => s.checkedAssets).includes(asset.id);
  const loadAsset = useTripoStore((s) => s.loadAsset);
  const toggleList = useTripoStore((s) => s.toggleList);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  // The card IS the working version — pipeline ops move this forward instead of
  // spawning another card.
  const version = currentVersion(asset);
  const steps = asset.versions.length;

  return (
    <div className="tp-asset-card" data-selected={selected} data-testid={`tp-asset-${asset.id}`}>
      <button
        type="button"
        className="tp-asset-hit"
        aria-label={asset.name}
        onClick={() => {
          if (manageMode) {
            toggleList('checkedAssets', asset.id);
          } else {
            loadAsset(asset.id);
          }
        }}
      >
        {version?.thumb != null ? (
          <img className="tp-asset-preview" src={version.thumb} alt={asset.name} />
        ) : (
          <span className="tp-asset-placeholder" data-testid={`tp-asset-pending-${asset.id}`}>
            <IcCube size={22} />
          </span>
        )}
      </button>

      {version?.rigged === true ? (
        <span className="tp-asset-rig" title="Rigged">
          <IcRig size={15} />
        </span>
      ) : null}
      {steps > 1 ? (
        <span
          className="tp-asset-steps"
          title={`${steps} versions in this asset's history`}
          data-testid={`tp-asset-steps-${asset.id}`}
        >
          {steps}
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
                <span>Version</span>
                <span>{version?.label ?? '—'}</span>
              </div>
              <div className="tp-asset-info-row">
                <span>Faces</span>
                <span>
                  {version !== undefined && version.faces > 0
                    ? version.faces.toLocaleString()
                    : '—'}
                </span>
              </div>
              <div className="tp-asset-info-row">
                <span>Vertices</span>
                <span>
                  {version !== undefined && version.vertices > 0
                    ? version.vertices.toLocaleString()
                    : '—'}
                </span>
              </div>
              <div className="tp-asset-info-row">
                <span>Topology</span>
                <span>{version?.topology ?? '—'}</span>
              </div>
              <div className="tp-asset-info-row">
                <span>Source</span>
                <span>{asset.source}</span>
              </div>
            </div>
          }
        />
      )}
    </div>
  );
}

function AssetsTab(): JSX.Element {
  const assets = useTripoStore((s) => s.assets);
  const assetFilter = useTripoStore((s) => s.assetFilter);
  const manageMode = useTripoStore((s) => s.manageMode);
  const checkedCount = useTripoStore((s) => s.checkedAssets).length;
  const set = useTripoStore((s) => s.set);
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const removeChecked = useTripoStore((s) => s.removeChecked);
  const uploadRef = useRef<HTMLInputElement>(null);

  const visible = assets.filter((a) => {
    if (assetFilter === 'generated') return a.source !== 'imported';
    if (assetFilter === 'imported') return a.source === 'imported';
    return true;
  });

  return (
    <>
      <div className="tp-assets-toolbar">
        <div className="tp-assets-filters">
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
            menu={(
              [
                ['all', 'All types'],
                ['generated', 'Generated'],
                ['imported', 'Imported'],
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
        <button
          type="button"
          className="tp-upload-card"
          data-testid="tp-upload-card"
          onClick={() => uploadRef.current?.click()}
        >
          <span className="tp-upload-orb">
            <IcUpload size={16} />
          </span>
          <span className="tp-upload-card-title">Upload 3D Model</span>
          <span className="tp-upload-card-sub">
            GLB, GLTF, OBJ, STL
            <br />
            or drop a file anywhere
          </span>
        </button>
        <input
          ref={uploadRef}
          type="file"
          accept=".glb,.gltf,.obj,.stl"
          style={{ display: 'none' }}
          data-testid="tp-upload-card-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void importModelFile(file);
            e.target.value = '';
          }}
        />
        {visible.map((a) => (
          <AssetCard key={a.id} asset={a} />
        ))}
      </div>

      {manageMode ? (
        <div className="tp-manage-bar" data-testid="tp-manage-bar">
          <span>{checkedCount} selected</span>
          <div className="tp-manage-actions">
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

// ── history tab: the asset's version tree ─────────────────────────────────

const OP_LABEL: Record<TripoOp, string> = {
  source: 'Source',
  segment: 'Segment',
  retopo: 'Retopology',
  texture: 'Texture',
  rig: 'Rig',
};

function VersionRow({
  asset,
  version,
}: {
  readonly asset: StudioAsset;
  readonly version: AssetVersion;
}): JSX.Element {
  const previewVersionId = useTripoStore((s) => s.previewVersionId);
  const previewVersion = useTripoStore((s) => s.previewVersion);
  const setCurrentVersion = useTripoStore((s) => s.setCurrentVersion);
  const isCurrent = asset.currentVersionId === version.id;
  const isViewing = previewVersionId === null ? isCurrent : previewVersionId === version.id;
  const depth = versionDepth(asset, version);
  const branch = hasSiblings(asset, version);

  return (
    <div
      className="tp-ver-row"
      data-current={isCurrent}
      data-viewing={isViewing}
      data-branch={branch}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      data-testid={`tp-ver-${version.id}`}
    >
      <button
        type="button"
        className="tp-ver-main"
        // Inspecting an earlier state must not silently change what the asset
        // IS — that is what "Make current" is for.
        onClick={() => previewVersion(isCurrent ? null : version.id)}
      >
        <span className="tp-ver-dot" data-op={version.op} />
        <span className="tp-ver-body">
          <span className="tp-ver-label">
            {OP_LABEL[version.op]}
            {branch ? <span className="tp-ver-branch-tag">branch</span> : null}
          </span>
          <span className="tp-ver-sub">
            {version.faces > 0 ? `${version.faces.toLocaleString()} faces` : version.label}
            {version.topology !== null ? ` · ${version.topology}` : ''}
          </span>
        </span>
      </button>
      {version.thumb !== null ? (
        <img className="tp-ver-thumb" src={version.thumb} alt="" />
      ) : (
        <span className="tp-ver-thumb tp-ver-thumb-empty">
          <IcCube size={13} />
        </span>
      )}
      {isCurrent ? (
        <span className="tp-ver-current" title="Current working version">
          <IcCheck size={13} />
        </span>
      ) : (
        <button
          type="button"
          className="tp-ver-make"
          data-testid={`tp-ver-make-${version.id}`}
          title="Make this the working version"
          onClick={() => {
            setCurrentVersion(asset.id, version.id);
            saveAssetTree();
          }}
        >
          Use
        </button>
      )}
    </div>
  );
}

/** Depth-first order so children sit directly under their parent — that is what
 * makes a branch legible as a branch. */
function orderedVersions(asset: StudioAsset): AssetVersion[] {
  const out: AssetVersion[] = [];
  const walk = (parentId: string | null): void => {
    for (const v of asset.versions.filter((x) => x.parentId === parentId)) {
      out.push(v);
      walk(v.id);
    }
  };
  walk(null);
  // Defensive: never drop a node whose parent went missing.
  for (const v of asset.versions) if (!out.includes(v)) out.push(v);
  return out;
}

function HistoryTab(): JSX.Element {
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const assets = useTripoStore((s) => s.assets);
  const previewVersionId = useTripoStore((s) => s.previewVersionId);
  const previewVersion = useTripoStore((s) => s.previewVersion);
  const asset = assets.find((a) => a.id === loadedAssetId);

  if (asset === undefined) {
    return (
      <div className="tp-property-empty" data-testid="tp-history-empty">
        <IcHistory size={26} />
        <p>Load a model to see its version history</p>
      </div>
    );
  }

  const rows = orderedVersions(asset);
  return (
    <>
      <div className="tp-section-title tp-hier-title">
        {asset.name} · {rows.length} version{rows.length === 1 ? '' : 's'}
      </div>
      <p className="tp-select-copy">
        Every operation adds a node here instead of a new asset. Click a node to inspect it; “Use”
        makes it the working version, and running an op from an older node creates a branch.
      </p>
      {previewVersionId !== null ? (
        <button
          type="button"
          className="tp-upload-btn"
          data-testid="tp-ver-back-to-current"
          onClick={() => previewVersion(null)}
        >
          Back to the working version
        </button>
      ) : null}
      <div className="tp-ver-tree" data-testid="tp-ver-tree">
        {rows.map((v) => (
          <VersionRow key={v.id} asset={asset} version={v} />
        ))}
      </div>
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
          if (row.id === 'mesh-node') {
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
  const assets = useTripoStore((s) => s.assets);
  const collapsed = useTripoStore((s) => s.hierarchyCollapsed);

  if (loadedAssetId === null) {
    return (
      <div className="tp-property-empty" data-testid="tp-property-empty">
        <IcBoxNode size={26} />
        <p>Select a model from Assets to inspect its hierarchy</p>
      </div>
    );
  }

  const asset = assets.find((a) => a.id === loadedAssetId);
  const rigged = asset !== undefined && currentVersion(asset)?.rigged === true;
  const meshRow: HierRow = {
    id: 'mesh-node',
    label: asset?.name ?? 'model',
    depth: rigged ? 2 : 0,
    icon: <IcBoxNode size={15} />,
    hasChildren: false,
    parent: rigged ? 'root' : undefined,
  };
  const hierarchy: readonly HierRow[] = rigged
    ? [
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
        meshRow,
      ]
    : [meshRow];

  const rows = hierarchy.filter((r) => {
    if (r.parent === undefined) return true;
    let p: string | undefined = r.parent;
    while (p !== undefined) {
      if (collapsed.includes(p)) return false;
      p = hierarchy.find((h) => h.id === p)?.parent;
    }
    return true;
  });

  return (
    <>
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
          data-active={rightTab === 'history'}
          data-testid="tp-tab-history"
          onClick={() => set('rightTab', 'history')}
        >
          <IcHistory size={15} />
          History
        </button>
        <button
          type="button"
          className="tp-right-tab"
          data-active={rightTab === 'property'}
          data-testid="tp-tab-property"
          onClick={() => set('rightTab', 'property')}
        >
          <IcLayers size={15} />
          {/* The tab shows a hierarchy of many nodes — "Properties", like the
              store key's sibling label. Kept the 'property' store value and
              testid so nothing functional moves. */}
          Properties
        </button>
      </div>
      <div className="tp-right-body">
        {rightTab === 'assets' ? <AssetsTab /> : null}
        {rightTab === 'history' ? <HistoryTab /> : null}
        {rightTab === 'property' ? <PropertyTab /> : null}
      </div>
    </aside>
  );
}
