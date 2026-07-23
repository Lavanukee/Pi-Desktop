/**
 * Tripo workspace store — ALL of the workspace's local UI state in one zustand
 * store. UI ONLY: nothing here talks to pi, the engine, or the main process;
 * "generate"-shaped actions only mutate local state. Selectors used by
 * components stay primitive (single fields) to avoid selector thrash.
 */
import { create } from 'zustand';

/** Left-rail tools. `fillparts` / `edit` / `upscale` / `pbr` are the expandable
 * sub-items under Segment and Texture, exactly as in the reference rail. */
export type TripoTool =
  | 'image'
  | 'model'
  | 'segment'
  | 'fillparts'
  | 'retopo'
  | 'texture'
  | 'edit'
  | 'upscale'
  | 'pbr'
  | 'animate';

export type TripoRightTab = 'assets' | 'property';
export type TripoInputMode = 'image' | 'multiview' | 'gallery' | 'text';
export type TripoRenderMode = 'clay' | 'shaded' | 'normal';
export type TripoMaterial = 'default' | 'matte' | 'gold' | 'chrome' | 'teal';
export type TripoModal = null | 'help' | 'export';

/**
 * The pipeline stage the viewer is currently showing for the loaded asset:
 *   mesh    → the dense generated base mesh (solid).
 *   retopo  → the clean quad-topology remesh (quad wireframe revealed).
 *   rig     → the retopo mesh with its skeleton/bones overlaid (bind pose).
 *   animate → the rigged mesh playing a skeletal animation clip.
 * These are backed by bundled sample GLBs, not live ML models — see Viewer3D.
 */
export type TripoStage = 'mesh' | 'retopo' | 'rig' | 'animate';

/** The asset the generation flow lands on (the rigged "wyrm" hero). */
export const HERO_ASSET_ID = 'asset-boy';

interface TripoState {
  // ── layout / navigation
  tool: TripoTool;
  railSegmentOpen: boolean;
  railTextureOpen: boolean;
  rightTab: TripoRightTab;
  /** The single open popover/dropdown (all menus are mutually exclusive). */
  openMenu: string | null;
  modal: TripoModal;
  helpSeen: boolean;

  // ── generate-model panel
  genMode: 'hd' | 'smart';
  inputMode: TripoInputMode;
  prompt: string;
  geoTexOpen: boolean;
  faceLimit: number;
  topology: 'triangle' | 'quad';
  symmetry: 'auto' | 'on' | 'off';
  pbrMaps: boolean;
  generateInParts: boolean;
  texture8k: boolean;
  privacyOpen: boolean;
  privacy: 'public' | 'private';
  genModel: string;

  // ── animate panel
  animModel: string;
  skeleton: boolean;
  animFilter: 'all' | 'basic' | 'interactive';
  animSearch: string;
  selectedAnim: string;

  // ── viewer
  loadedAssetId: string | null;
  /** Which pipeline result the viewer renders for the loaded asset. */
  pipelineStage: TripoStage;
  wireframe: boolean;
  showGrid: boolean;
  autoRotate: boolean;
  envLight: boolean;
  lightIntensity: number;
  renderMode: TripoRenderMode;
  material: TripoMaterial;
  meshVisible: boolean;

  // ── assets panel
  selectedAssetId: string | null;
  favorites: readonly string[];
  favOnly: boolean;
  assetFilter: 'all' | 'generated' | 'uploaded' | 'rigged';
  manageMode: boolean;
  checkedAssets: readonly string[];
  removedAssets: readonly string[];

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
  /** Run a pipeline stage (loading the hero asset first if none is loaded).
   * Sample-asset-backed: it swaps which bundled GLB result the viewer shows. */
  runStage: (stage: TripoStage) => void;
  toggleList: (
    key: 'favorites' | 'checkedAssets' | 'hierarchyCollapsed' | 'hiddenNodes',
    id: string,
  ) => void;
  removeChecked: () => void;
}

const toggled = (list: readonly string[], id: string): readonly string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

export const useTripoStore = create<TripoState>((set, get) => ({
  tool: 'model',
  railSegmentOpen: false,
  railTextureOpen: false,
  rightTab: 'assets',
  openMenu: null,
  modal: null,
  helpSeen: false,

  genMode: 'hd',
  inputMode: 'image',
  prompt: '',
  geoTexOpen: false,
  faceLimit: 30,
  topology: 'triangle',
  symmetry: 'auto',
  pbrMaps: true,
  generateInParts: false,
  texture8k: true,
  privacyOpen: false,
  privacy: 'public',
  genModel: 'v3.1',

  animModel: 'v2.5',
  skeleton: false,
  animFilter: 'all',
  animSearch: '',
  selectedAnim: 'angry_01',

  loadedAssetId: null,
  pipelineStage: 'mesh',
  wireframe: false,
  showGrid: false,
  autoRotate: false,
  envLight: true,
  lightIntensity: 60,
  renderMode: 'shaded',
  material: 'default',
  meshVisible: true,

  selectedAssetId: null,
  favorites: ['asset-cottage'],
  favOnly: false,
  assetFilter: 'all',
  manageMode: false,
  checkedAssets: [],
  removedAssets: [],

  hierarchyCollapsed: [],
  hiddenNodes: [],
  selectedNode: 'tripo_node_711b6583',

  setTool: (tool) => {
    // Selecting Segment / Texture also expands their sub-item group, mirroring
    // the reference rail (the caret rows reveal Fill Parts / Edit-Upscale-PBR).
    set((s) => ({
      tool,
      openMenu: null,
      railSegmentOpen: tool === 'segment' || tool === 'fillparts' ? true : s.railSegmentOpen,
      railTextureOpen:
        tool === 'texture' || tool === 'edit' || tool === 'upscale' || tool === 'pbr'
          ? true
          : s.railTextureOpen,
    }));
  },
  set: (key, value) => set({ [key]: value } as Partial<TripoState>),
  toggleMenu: (id) => set((s) => ({ openMenu: s.openMenu === id ? null : id })),
  closeMenus: () => set({ openMenu: null }),
  loadAsset: (id) => {
    const first = !get().helpSeen;
    set({
      loadedAssetId: id,
      selectedAssetId: id,
      meshVisible: true,
      // A freshly loaded asset starts at its generated base mesh.
      pipelineStage: 'mesh',
      // The "View Your Model" coach dialog appears the first time a model
      // lands in the viewport (as in the reference), then never again.
      modal: first ? 'help' : get().modal,
      helpSeen: true,
    });
  },
  runStage: (stage) =>
    set((s) => ({
      pipelineStage: stage,
      loadedAssetId: s.loadedAssetId ?? HERO_ASSET_ID,
      selectedAssetId: s.selectedAssetId ?? HERO_ASSET_ID,
      meshVisible: true,
    })),
  toggleList: (key, id) => set((s) => ({ [key]: toggled(s[key], id) }) as Partial<TripoState>),
  removeChecked: () =>
    set((s) => ({
      removedAssets: [...s.removedAssets, ...s.checkedAssets],
      checkedAssets: [],
      manageMode: false,
    })),
}));
