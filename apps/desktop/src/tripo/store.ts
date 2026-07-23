/**
 * Bobble 3D studio store — the workspace's UI + pipeline state in one zustand
 * store. Assets are LIVE state (the sample creature + anything generated or
 * imported this session) with real rendered thumbnails captured by the viewer;
 * there are no fixture assets, no credits, and no promo state. Selectors used
 * by components stay primitive (single fields) to avoid selector thrash.
 */
import { create } from 'zustand';

/** Left-rail tools — one per functional pipeline section (flat: no sub-tools). */
export type TripoTool = 'image' | 'model' | 'segment' | 'retopo' | 'texture' | 'animate';

export type TripoRightTab = 'assets' | 'property';
export type TripoInputMode = 'image' | 'multiview' | 'gallery' | 'text';
/** Viewport render modes; wireframe is a separate ON/OFF overlay toggle that
 * draws edges ON TOP of the active mode (jedd). */
export type TripoRenderMode = 'clay' | 'textured' | 'normal';
export type TripoModal = null | 'help' | 'export';

/**
 * The pipeline stage the viewer is currently showing for the loaded asset:
 *   mesh    → the dense generated base mesh (solid).
 *   segment → the mesh split into colored semantic parts (CubePart stage).
 *   retopo  → the clean quad-topology remesh (quad wireframe revealed).
 *   texture → the mesh with a generated texture applied (Textured mode).
 *   rig     → the retopo mesh with its skeleton/bones overlaid (bind pose).
 *   animate → the rigged mesh playing a skeletal animation clip.
 * The demo pipeline is backed by bundled sample GLBs + real geometry passes
 * (vertex-color segmentation, procedural texture) — not live ML runs yet; the
 * per-stage model names in data.ts label the intended engines.
 */
export type TripoStage = 'mesh' | 'segment' | 'retopo' | 'texture' | 'rig' | 'animate';

/** The bundled sample asset the generation flow lands on. */
export const HERO_ASSET_ID = 'asset-sample';

/** One asset in the right-panel grid. `thumb` is a REAL rendered preview (a
 * viewer-captured dataURL) — never icon artwork. */
export interface StudioAsset {
  readonly id: string;
  readonly name: string;
  readonly source: 'sample' | 'generated' | 'imported';
  readonly rigged?: boolean;
  readonly thumb: string | null;
  /** On-disk path when known (imported files, engine artifacts) — what the
   * gen3d engine's stage ops take as input. The bundled sample has none. */
  readonly diskPath?: string;
  readonly faces: number;
  readonly vertices: number;
  readonly created: string;
}

/** A row in the (real) task-history popover: stages run this session. */
export interface StageHistoryRow {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
}

const STAGE_LABEL: Record<TripoStage, string> = {
  mesh: 'Generate Model',
  segment: 'Segment Parts',
  retopo: 'Retopology',
  texture: 'Generate Texture',
  rig: 'Rig & Skeleton',
  animate: 'Animate',
};

interface TripoState {
  // ── layout / navigation
  tool: TripoTool;
  rightTab: TripoRightTab;
  /** The single open popover/dropdown (all menus are mutually exclusive). */
  openMenu: string | null;
  modal: TripoModal;
  helpSeen: boolean;

  // ── generate-model panel
  inputMode: TripoInputMode;
  prompt: string;
  geoTexOpen: boolean;
  faceLimit: number;
  topology: 'triangle' | 'quad';
  symmetry: 'auto' | 'on' | 'off';
  genModel: string;
  /** TRELLIS structure resolution preset for generation. */
  genResolution: 'low' | 'medium' | 'high';
  /** Chain Hunyuan Paint texturing after geometry. */
  genAutoTexture: boolean;
  /** Picked input image (absolute path + display name) for image→3D. */
  genImagePath: string | null;
  genImageName: string | null;

  // ── animate panel
  skeleton: boolean;
  animFilter: 'all' | 'basic' | 'interactive';
  animSearch: string;
  selectedAnim: string;

  // ── viewer
  loadedAssetId: string | null;
  /** Which pipeline result the viewer renders for the loaded asset. */
  pipelineStage: TripoStage;
  renderMode: TripoRenderMode;
  /** Edge overlay drawn on top of the active render mode. */
  wireframe: boolean;
  showGrid: boolean;
  autoRotate: boolean;
  envLight: boolean;
  lightIntensity: number;
  meshVisible: boolean;
  /** Real topology counts of what is on screen — written by the viewer. */
  stats: { topology: string; faces: number; vertices: number } | null;
  /** Part names from the segment stage — written by the viewer. */
  segmentParts: readonly string[];

  // ── assets panel (live state, no fixtures)
  assets: readonly StudioAsset[];
  selectedAssetId: string | null;
  assetFilter: 'all' | 'generated' | 'imported';
  manageMode: boolean;
  checkedAssets: readonly string[];

  // ── history (real: stages run this session)
  history: readonly StageHistoryRow[];

  // ── property panel (hierarchy)
  hierarchyCollapsed: readonly string[];
  hiddenNodes: readonly string[];
  selectedNode: string | null;

  // ── actions
  setTool: (tool: TripoTool) => void;
  set: <K extends keyof TripoState>(key: K, value: TripoState[K]) => void;
  toggleMenu: (id: string) => void;
  closeMenus: () => void;
  loadAsset: (id: string) => void;
  /** Run a pipeline stage on the loaded asset (loads the sample if none). */
  runStage: (stage: TripoStage) => void;
  addAsset: (asset: StudioAsset) => void;
  /** The viewer captured a real rendered preview for an asset. */
  setAssetThumb: (id: string, thumb: string) => void;
  setAssetCounts: (id: string, faces: number, vertices: number) => void;
  toggleList: (key: 'checkedAssets' | 'hierarchyCollapsed' | 'hiddenNodes', id: string) => void;
  removeChecked: () => void;
}

const toggled = (list: readonly string[], id: string): readonly string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

const SAMPLE_ASSET: StudioAsset = {
  id: HERO_ASSET_ID,
  name: 'sample_creature',
  source: 'sample',
  rigged: true,
  thumb: null,
  faces: 21600,
  vertices: 10872,
  created: 'Bundled sample',
};

export const useTripoStore = create<TripoState>((set, get) => ({
  tool: 'model',
  rightTab: 'assets',
  openMenu: null,
  modal: null,
  helpSeen: false,

  inputMode: 'image',
  prompt: '',
  geoTexOpen: false,
  faceLimit: 30,
  topology: 'triangle',
  symmetry: 'auto',
  genModel: 'trellis-2',
  genResolution: 'medium',
  genAutoTexture: true,
  genImagePath: null,
  genImageName: null,

  skeleton: false,
  animFilter: 'all',
  animSearch: '',
  selectedAnim: 'angry_01',

  loadedAssetId: null,
  pipelineStage: 'mesh',
  renderMode: 'clay',
  wireframe: false,
  showGrid: false,
  autoRotate: false,
  envLight: true,
  lightIntensity: 60,
  meshVisible: true,
  stats: null,
  segmentParts: [],

  assets: [SAMPLE_ASSET],
  selectedAssetId: null,
  assetFilter: 'all',
  manageMode: false,
  checkedAssets: [],

  history: [],

  hierarchyCollapsed: [],
  hiddenNodes: [],
  selectedNode: 'mesh-node',

  setTool: (tool) => set({ tool, openMenu: null }),
  set: (key, value) => set({ [key]: value } as Partial<TripoState>),
  toggleMenu: (id) => set((s) => ({ openMenu: s.openMenu === id ? null : id })),
  closeMenus: () => set({ openMenu: null }),
  loadAsset: (id) => {
    const first = !get().helpSeen;
    // Loading the sample after it was deleted restores its asset row.
    if (id === HERO_ASSET_ID && !get().assets.some((a) => a.id === id)) {
      set((s) => ({ assets: [SAMPLE_ASSET, ...s.assets] }));
    }
    set({
      loadedAssetId: id,
      selectedAssetId: id,
      meshVisible: true,
      // A freshly loaded asset starts at its base mesh in Clay.
      pipelineStage: 'mesh',
      renderMode: 'clay',
      segmentParts: [],
      // The "View Your Model" coach dialog appears the first time a model
      // lands in the viewport, then never again.
      modal: first ? 'help' : get().modal,
      helpSeen: true,
    });
  },
  runStage: (stage) =>
    set((s) => {
      const loadedAssetId = s.loadedAssetId ?? HERO_ASSET_ID;
      const asset = s.assets.find((a) => a.id === loadedAssetId);
      // Generating after deleting the sample brings it back (it's the target).
      const assets =
        asset === undefined && loadedAssetId === HERO_ASSET_ID
          ? [SAMPLE_ASSET, ...s.assets]
          : s.assets;
      return {
        assets,
        pipelineStage: stage,
        loadedAssetId,
        selectedAssetId: s.selectedAssetId ?? loadedAssetId,
        meshVisible: true,
        // The texture stage is what the Textured mode exists to show.
        renderMode: stage === 'texture' ? 'textured' : s.renderMode,
        segmentParts: stage === 'segment' ? s.segmentParts : [],
        history: [
          {
            id: `h-${s.history.length + 1}`,
            label: STAGE_LABEL[stage],
            sub: asset?.name ?? 'sample_creature',
          },
          ...s.history,
        ].slice(0, 12),
      };
    }),
  addAsset: (asset) =>
    set((s) => ({
      assets: [asset, ...s.assets],
    })),
  setAssetThumb: (id, thumb) =>
    set((s) => ({
      assets: s.assets.map((a) => (a.id === id ? { ...a, thumb } : a)),
    })),
  setAssetCounts: (id, faces, vertices) =>
    set((s) => ({
      assets: s.assets.map((a) => (a.id === id ? { ...a, faces, vertices } : a)),
    })),
  toggleList: (key, id) => set((s) => ({ [key]: toggled(s[key], id) }) as Partial<TripoState>),
  removeChecked: () =>
    set((s) => ({
      // The bundled sample can be removed from view too — it comes back on the
      // next Generate (runStage re-targets it), which is the obvious behavior.
      assets: s.assets.filter((a) => !s.checkedAssets.includes(a.id)),
      checkedAssets: [],
      manageMode: false,
      loadedAssetId: s.checkedAssets.includes(s.loadedAssetId ?? '') ? null : s.loadedAssetId,
      selectedAssetId: s.checkedAssets.includes(s.selectedAssetId ?? '') ? null : s.selectedAssetId,
    })),
}));
