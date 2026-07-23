/**
 * Static mock data for the Tripo workspace UI — assets, animation presets,
 * model versions, DCC export targets, notifications. Pure fixtures: the wiring
 * phase will replace these with real generation state.
 */

export interface TripoAsset {
  readonly id: string;
  readonly name: string;
  /** Which thumbnail artwork to draw (see thumbs.tsx). */
  readonly art: 'boy' | 'cottage' | 'fireplace' | 'dancer' | 'sofa' | 'bust' | 'diorama' | 'mech';
  readonly rigged?: boolean;
  readonly source: 'generated' | 'uploaded';
  readonly faces: number;
  readonly vertices: number;
  readonly created: string;
  /** In-flight generation state → the card renders a progress row instead. */
  readonly progress?: number;
  readonly queued?: boolean;
}

export const TRIPO_ASSETS: readonly TripoAsset[] = [
  {
    id: 'asset-boy',
    name: 'tripo_node_711b6583',
    art: 'boy',
    rigged: true,
    source: 'generated',
    faces: 4848,
    vertices: 3348,
    created: 'Today, 7:12 PM',
  },
  {
    id: 'asset-mech',
    name: 'scout_mech_04',
    art: 'mech',
    source: 'generated',
    faces: 0,
    vertices: 0,
    created: 'Generating…',
    progress: 62,
  },
  {
    id: 'asset-cottage',
    name: 'storybook_cottage',
    art: 'cottage',
    source: 'generated',
    faces: 21440,
    vertices: 11856,
    created: 'Today, 6:48 PM',
  },
  {
    id: 'asset-fireplace',
    name: 'gothic_fireplace',
    art: 'fireplace',
    source: 'generated',
    faces: 18220,
    vertices: 9931,
    created: 'Today, 6:31 PM',
  },
  {
    id: 'asset-dancer',
    name: 'porcelain_dancer',
    art: 'dancer',
    source: 'generated',
    faces: 32780,
    vertices: 17204,
    created: 'Yesterday',
  },
  {
    id: 'asset-sofa',
    name: 'chesterfield_sofa',
    art: 'sofa',
    source: 'uploaded',
    faces: 9640,
    vertices: 5122,
    created: 'Yesterday',
  },
  {
    id: 'asset-bust',
    name: 'baroque_portrait',
    art: 'bust',
    source: 'generated',
    faces: 41020,
    vertices: 21550,
    created: 'Jul 20',
  },
  {
    id: 'asset-diorama',
    name: 'wishing_well_diorama',
    art: 'diorama',
    source: 'generated',
    faces: 27310,
    vertices: 14468,
    created: 'Jul 19',
    queued: true,
  },
];

/** Animation presets for the Animate panel grid (pose id → mannequin pose). */
export interface TripoAnim {
  readonly id: string;
  readonly kind: 'basic' | 'interactive';
}
export const TRIPO_ANIMS: readonly TripoAnim[] = [
  { id: 'angry_01', kind: 'basic' },
  { id: 'afraid', kind: 'basic' },
  { id: 'agree', kind: 'interactive' },
  { id: 'angry_02', kind: 'basic' },
  { id: 'cheer', kind: 'interactive' },
  { id: 'clap', kind: 'interactive' },
  { id: 'dance_01', kind: 'basic' },
  { id: 'hello', kind: 'interactive' },
  { id: 'idle', kind: 'basic' },
  { id: 'jump', kind: 'basic' },
  { id: 'kick', kind: 'basic' },
  { id: 'point', kind: 'interactive' },
  { id: 'run', kind: 'basic' },
  { id: 'sad_01', kind: 'basic' },
  { id: 'walk', kind: 'basic' },
  { id: 'wave', kind: 'interactive' },
];

export interface ModelVersion {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
}
export const GEN_MODELS: readonly ModelVersion[] = [
  { id: 'v3.1', label: 'v3.1 – Best Quality', hint: 'Expect longer wait times' },
  { id: 'v3.0', label: 'v3.0 – Balanced', hint: 'Great quality, faster' },
  { id: 'v2.5', label: 'v2.5 – Fast', hint: 'Drafts and iteration' },
];
export const ANIM_MODELS: readonly ModelVersion[] = [
  { id: 'v2.5', label: 'v2.5 – Good for Animals', hint: 'Quadrupeds + humanoids' },
  { id: 'v2.0', label: 'v2.0 – Humanoid Only', hint: 'Bipeds, stable retarget' },
];

export const SEND_TO_TARGETS: readonly { id: string; label: string; beta?: boolean }[] = [
  { id: 'blender', label: 'Send To Blender' },
  { id: '3dsmax', label: 'Send To 3ds Max' },
  { id: 'unity', label: 'Send To Unity' },
  { id: 'unreal', label: 'Send To Unreal' },
  { id: 'maya', label: 'Send To Maya' },
  { id: 'cocos', label: 'Send To Cocos' },
  { id: 'godot', label: 'Send To Godot' },
  { id: 'zbrush', label: 'Send To ZBrush' },
  { id: 'metatailor', label: 'Send To MetaTailor', beta: true },
];

export const EXPORT_FORMATS = ['GLB', 'FBX', 'OBJ', 'STL', 'USDZ'] as const;
export const EXPORT_QUALITY = [
  'Original',
  'High (50K faces)',
  'Medium (20K faces)',
  'Low (5K faces)',
] as const;

export const LANGUAGES = ['English', '中文', '日本語', '한국어', 'Deutsch', 'Français'] as const;

export interface TripoNotification {
  readonly id: string;
  readonly title: string;
  readonly time: string;
  readonly unread: boolean;
}
export const NOTIFICATIONS: readonly TripoNotification[] = [
  { id: 'n1', title: 'scout_mech_04 is generating — 62%', time: '2m ago', unread: true },
  { id: 'n2', title: 'storybook_cottage finished generating', time: '34m ago', unread: true },
  { id: 'n3', title: 'Weekly free credits refreshed (+200)', time: '8h ago', unread: true },
];

export interface HistoryRow {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
  readonly state: 'done' | 'running' | 'queued';
  readonly progress?: number;
}
export const HISTORY_ROWS: readonly HistoryRow[] = [
  { id: 'h1', label: 'Generate Model', sub: 'scout_mech_04', state: 'running', progress: 62 },
  { id: 'h2', label: 'Rigging', sub: 'wishing_well_diorama', state: 'queued' },
  { id: 'h3', label: 'Generate Model', sub: 'storybook_cottage', state: 'done' },
  { id: 'h4', label: 'Texture 8K', sub: 'gothic_fireplace', state: 'done' },
  { id: 'h5', label: 'Generate Model', sub: 'tripo_node_711b6583', state: 'done' },
];

export const DCC_BRIDGES = ['Blender', 'Maya', '3ds Max', 'Unity'] as const;

export const WORKSPACE_MENU = [
  { id: 'workspace3d', label: '3D Workspace', active: true },
  { id: 'imagestudio', label: 'Image Studio', active: false },
  { id: 'apiplatform', label: 'API Platform', active: false },
  { id: 'myassets', label: 'My Assets', active: false },
] as const;
