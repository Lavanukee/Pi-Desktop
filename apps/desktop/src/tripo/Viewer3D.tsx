/**
 * The center 3D viewer — a raw three.js scene rendering the studio's pipeline
 * stages for the loaded asset (bundled sample OR an imported file), driven by
 * the zustand store. Loaded ONLY through React.lazy so three stays folded into
 * this chunk.
 *
 *   mesh    → the base mesh, solid.
 *   segment → the mesh split into colored parts (vertex-color bands — the
 *             CubePart stage's demo pass; part names land in the store).
 *   retopo  → sample: the bundled clean-quad remesh + quad wireframe;
 *             imported: the model's REAL edge wireframe.
 *   texture → a generated procedural texture applied (Textured render mode).
 *   rig     → the sample's real three.js Skeleton overlaid (bind pose).
 *   animate → the rigged SkinnedMesh playing a baked AnimationClip.
 *
 * Render modes (viewport strip): Clay · Textured · Normal · Wireframe.
 *
 * HONESTY: the sample stages are backed by two bundled GLBs (hero-glb.ts) and
 * real geometry passes (vertex-color segmentation, procedural texture) — NOT
 * live runs of the intended engines (Hunyuan/TRELLIS, CubePart, AutoRemesher,
 * SkinTokens, ARDY). Imported files are decoded with the real three loaders
 * (GLTF/OBJ/STL) and normalized into the scene.
 *
 * Also owns: REAL export (GLTF/OBJ/STL/USDZ exporters via the viewer-io bus)
 * and asset thumbnails (a downscaled capture of the first rendered frame —
 * the "quick preview" that replaces icon artwork in the Assets grid).
 */

import {
  GLTFExporter,
  GLTFLoader,
  OBJExporter,
  OBJLoader,
  OrbitControls,
  RoomEnvironment,
  STLExporter,
  STLLoader,
  THREE,
  USDZExporter,
} from '@pi-desktop/canvas/three';
import type { JSX } from 'react';
import { useEffect, useRef } from 'react';
import { importedModel } from './asset-registry';
import { HERO_MESH_GLB_B64, HERO_RIG_GLB_B64 } from './assets/hero-glb';
import { HERO_ASSET_ID, useTripoStore } from './store';
import { setViewerExportHandler, type ViewerExportRequest } from './viewer-io';

/** Resolve an arbitrary CSS color expression (var()/color-mix()) to an sRGB
 * string three can parse, using a detached probe span's computed style. */
function resolveColor(expr: string): string {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = expr;
  document.body.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out === '' ? 'rgb(128,128,128)' : out;
}

/** Segment-part palette (kept in sync with .tp-part-swatch in tripo.css). */
const PART_COLORS = ['#e8863a', '#4a90d9', '#58b368', '#d9b44a'] as const;

// ── shared creature profile (mirrors build-hero-glb.mjs) — used to draw the
// clean QUAD wireframe that reveals the retopology topology. ─────────────────
const RINGS = 20;
const RADIAL = 16;
const Y_TAIL = -1.35;
const Y_NECK = 1.15;
const GROUND_Y = -1.42;
const radiusAt = (t: number): number => 0.14 + 0.5 * Math.exp(-(((t - 0.4) / 0.34) ** 2));
const yAt = (t: number): number => Y_TAIL + (Y_NECK - Y_TAIL) * t;

/** LineSegments of only the quad grid edges (rings + spine, no triangle
 * diagonals) so the retopo stage reads as clean quads rather than tris. */
function buildQuadWire(): InstanceType<typeof THREE.LineSegments> {
  const pts: number[] = [];
  const at = (i: number, j: number): [number, number, number] => {
    const t = i / RINGS;
    const r = radiusAt(t);
    const a = ((j % RADIAL) / RADIAL) * Math.PI * 2;
    return [Math.cos(a) * r, yAt(t), Math.sin(a) * r];
  };
  const push = (p: [number, number, number]) => pts.push(p[0], p[1], p[2]);
  for (let i = 0; i <= RINGS; i++) {
    for (let j = 0; j < RADIAL; j++) {
      push(at(i, j));
      push(at(i, j + 1)); // ring edge
    }
  }
  for (let j = 0; j < RADIAL; j++) {
    for (let i = 0; i < RINGS; i++) {
      push(at(i, j));
      push(at(i + 1, j)); // spine edge
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9 });
  return new THREE.LineSegments(geo, mat);
}

/** Map an animation-preset id (angry_01, dance_01, idle, wave, …) to one of the
 * three baked clips in the rig GLB (idle / wave / coil). */
function clipFor(preset: string): string {
  const s = preset.toLowerCase();
  if (s.includes('idle')) return 'idle';
  if (/dance|coil|jump|kick|angry|run|cheer/.test(s)) return 'coil';
  return 'wave';
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Paint per-vertex part colors by height band; returns the part count used. */
function paintSegmentColors(geo: InstanceType<typeof THREE.BufferGeometry>): number {
  const pos = geo.getAttribute('position') as InstanceType<typeof THREE.BufferAttribute>;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (bb === null) return 0;
  const minY = bb.min.y;
  const span = Math.max(bb.max.y - bb.min.y, 1e-6);
  const parts = 3;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - minY) / span;
    // Top-down band order so part 0 (the list's first row, e.g. "Head") is the
    // TOP of the model — the panel swatches then match the painted regions.
    const band = parts - 1 - Math.min(parts - 1, Math.floor(t * parts));
    c.set(PART_COLORS[band] ?? PART_COLORS[0]);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return parts;
}

/** Generate the procedural "generated texture": muted painterly bands +
 * speckle. Returns an sRGB CanvasTexture (the Hunyuan-Paint stage's demo). */
function buildGeneratedTexture(): InstanceType<typeof THREE.CanvasTexture> {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const bands = ['#c8a06a', '#a8784a', '#8a5c38', '#c8a06a', '#e0c090'];
    const bandH = size / bands.length;
    bands.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, i * bandH, size, bandH + 1);
    });
    // Speckle for a hand-painted read (deterministic LCG, no Math.random).
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 2600; i++) {
      const a = 0.05 + rand() * 0.1;
      ctx.fillStyle = rand() > 0.5 ? `rgba(255,240,210,${a})` : `rgba(60,35,20,${a})`;
      const r = 1 + rand() * 3;
      ctx.beginPath();
      ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Trigger a browser download for exported bytes/text. */
function downloadBlob(data: BlobPart, fileName: string, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Minimal shape of the GLTFLoader.parse result we consume. */
interface LoadedGLTF {
  readonly scene: InstanceType<typeof THREE.Group>;
  readonly animations: InstanceType<typeof THREE.AnimationClip>[];
}

export interface Viewer3DProps {
  /** The axis-gizmo DOM to keep in sync (elements tagged data-ax / data-axline). */
  readonly gizmoRef: React.RefObject<HTMLDivElement | null>;
}

export default function Viewer3D({ gizmoRef }: Viewer3DProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    // ── renderer (Metal / WebGL quality pass) ───────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(2.9, 1.35, 4.6);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.0, 0);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // Studio rig: hemisphere fill + shadow-casting warm key + cool rim.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3.2, 5.2, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 22;
    key.shadow.camera.left = -3.2;
    key.shadow.camera.right = 3.2;
    key.shadow.camera.top = 3.2;
    key.shadow.camera.bottom = -3.2;
    key.shadow.bias = -0.0006;
    key.shadow.radius = 3;
    const rim = new THREE.DirectionalLight(0xffffff, 1.1);
    rim.position.set(-3.5, 2.5, -3);
    scene.add(hemi, key, rim);

    // Ground: a shadow-catcher disc + a toggleable grid.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(7, 64),
      new THREE.ShadowMaterial({ opacity: 0.3 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(10, 20);
    grid.position.y = GROUND_Y;
    scene.add(grid);

    // Retopo quad-wire overlay for the SAMPLE (bind pose).
    const quadWire = buildQuadWire();
    quadWire.visible = false;
    scene.add(quadWire);

    // ── shared materials for the render modes ───────────────────────────────
    const normalMat = new THREE.MeshNormalMaterial();
    const clayMat = new THREE.MeshStandardMaterial({ metalness: 0.02, roughness: 0.85 });
    const wireMat = new THREE.MeshStandardMaterial({
      metalness: 0.02,
      roughness: 0.85,
      wireframe: true,
    });
    const segMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
    const generatedTexture = buildGeneratedTexture();
    const texMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
    // Assets whose texture stage has run — Textured mode maps only those.
    const texturedAssets = new Set<string>();
    // Geometries already painted with segment colors.
    const segPainted = new WeakSet<object>();

    // ── pipeline models ─────────────────────────────────────────────────────
    interface BodyRef {
      readonly mesh: InstanceType<typeof THREE.Mesh>;
    }
    let meshModel: InstanceType<typeof THREE.Group> | null = null;
    let rigModel: InstanceType<typeof THREE.Group> | null = null;
    let skinned: InstanceType<typeof THREE.SkinnedMesh> | null = null;
    let skeletonHelper: InstanceType<typeof THREE.SkeletonHelper> | null = null;
    let mixer: InstanceType<typeof THREE.AnimationMixer> | null = null;
    const actions = new Map<string, InstanceType<typeof THREE.AnimationAction>>();
    let current: InstanceType<typeof THREE.AnimationAction> | null = null;
    const meshBodies: BodyRef[] = [];
    const rigBodies: BodyRef[] = [];
    const boneJoints: InstanceType<typeof THREE.Mesh>[] = [];
    let heroLoaded = false;
    let disposed = false;

    // Imported (drag-and-drop / upload) model currently in the scene.
    let importedGroup: InstanceType<typeof THREE.Group> | null = null;
    let importedWire: InstanceType<typeof THREE.LineSegments> | null = null;
    let importedId: string | null = null;
    const importedBodies: BodyRef[] = [];

    // Thumbnail capture queue: asset ids whose real preview is still pending.
    let pendingThumb: string | null = null;

    const collectBodies = (
      root: InstanceType<typeof THREE.Group>,
      into: BodyRef[],
      filter?: (m: InstanceType<typeof THREE.Mesh>) => boolean,
    ) => {
      root.traverse((o) => {
        const mesh = o as InstanceType<typeof THREE.Mesh>;
        if (mesh.isMesh === true) {
          mesh.castShadow = true;
          mesh.frustumCulled = false; // skinned bones can push verts past the bbox
          if (filter === undefined || filter(mesh)) into.push({ mesh });
        }
      });
    };

    const loader = new GLTFLoader();
    const parseGlb = (data: ArrayBuffer | string): Promise<LoadedGLTF> =>
      new Promise((resolve, reject) =>
        loader.parse(data, '', (g) => resolve(g as unknown as LoadedGLTF), reject),
      );

    void Promise.all([
      parseGlb(base64ToArrayBuffer(HERO_MESH_GLB_B64)),
      parseGlb(base64ToArrayBuffer(HERO_RIG_GLB_B64)),
    ]).then(([meshGltf, rigGltf]) => {
      if (disposed) return;
      meshModel = meshGltf.scene;
      collectBodies(meshModel, meshBodies, (m) => m.name.startsWith('wyrm'));
      meshModel.visible = false;
      scene.add(meshModel);

      rigModel = rigGltf.scene;
      collectBodies(rigModel, rigBodies, (m) => m.name.startsWith('wyrm'));
      rigModel.visible = false;
      rigModel.traverse((o) => {
        const sm = o as InstanceType<typeof THREE.SkinnedMesh>;
        if (sm.isSkinnedMesh === true) skinned = sm;
      });
      scene.add(rigModel);

      skeletonHelper = new THREE.SkeletonHelper(rigModel);
      skeletonHelper.visible = false;
      scene.add(skeletonHelper);

      mixer = new THREE.AnimationMixer(rigModel);
      for (const clip of rigGltf.animations) {
        actions.set(clip.name, mixer.clipAction(clip));
      }

      if (skinned !== null) {
        const jointGeo = new THREE.SphereGeometry(0.055, 14, 12);
        for (const bone of skinned.skeleton.bones) {
          const bead = new THREE.Mesh(
            jointGeo,
            new THREE.MeshBasicMaterial({ depthTest: false, transparent: true }),
          );
          bead.renderOrder = 10;
          bead.frustumCulled = false;
          bead.visible = false;
          bone.add(bead);
          boneJoints.push(bead);
        }
      }

      heroLoaded = true;
      applyState();
    });

    /** Load an imported (registry) asset into the scene, replacing the last. */
    const loadImported = async (id: string): Promise<void> => {
      const entry = importedModel(id);
      if (entry === undefined) return;
      let group: InstanceType<typeof THREE.Group> | null = null;
      try {
        if (entry.format === 'glb' || entry.format === 'gltf') {
          group = (await parseGlb(entry.buffer)).scene;
        } else if (entry.format === 'obj') {
          const text = new TextDecoder().decode(entry.buffer);
          group = new OBJLoader().parse(text) as InstanceType<typeof THREE.Group>;
        } else {
          const geo = new STLLoader().parse(entry.buffer);
          geo.computeVertexNormals();
          const mesh = new THREE.Mesh(geo, clayMat);
          group = new THREE.Group();
          group.add(mesh);
        }
      } catch {
        return; // unreadable file — leave the current scene as-is
      }
      if (disposed || group === null) return;
      if (importedGroup !== null) scene.remove(importedGroup);
      if (importedWire !== null) scene.remove(importedWire);
      importedBodies.length = 0;

      // Normalize: fit to a ~2.6-unit height, feet on the ground plane.
      const bb = new THREE.Box3().setFromObject(group);
      const size = bb.getSize(new THREE.Vector3());
      const scale = 2.6 / Math.max(size.x, size.y, size.z, 1e-6);
      group.scale.setScalar(scale);
      const bb2 = new THREE.Box3().setFromObject(group);
      const center = bb2.getCenter(new THREE.Vector3());
      group.position.x -= center.x;
      group.position.z -= center.z;
      group.position.y -= bb2.min.y - GROUND_Y;

      collectBodies(group, importedBodies);
      // The model's REAL edge wireframe (its actual topology) for retopo view.
      const wires = new THREE.Group();
      for (const { mesh } of importedBodies) {
        const wg = new THREE.WireframeGeometry(mesh.geometry);
        const seg = new THREE.LineSegments(
          wg,
          new THREE.LineBasicMaterial({ transparent: true, opacity: 0.85 }),
        );
        mesh.updateWorldMatrix(true, false);
        seg.applyMatrix4(mesh.matrixWorld);
        wires.add(seg);
      }
      importedWire = wires as unknown as InstanceType<typeof THREE.LineSegments>;
      importedWire.visible = false;

      importedGroup = group;
      importedId = id;
      scene.add(group, wires);

      // Real counts → asset row + (via applyState) the stats readout.
      let faces = 0;
      let verts = 0;
      for (const { mesh } of importedBodies) {
        const g = mesh.geometry;
        faces += Math.floor(
          (g.index !== null ? g.index.count : g.getAttribute('position').count) / 3,
        );
        verts += g.getAttribute('position').count;
      }
      useTripoStore.getState().setAssetCounts(id, faces, verts);
      pendingThumb = id;
      applyState();
    };

    // ── real export (three exporters) ───────────────────────────────────────
    const exportRoot = (): InstanceType<typeof THREE.Object3D> | null => {
      const s = useTripoStore.getState();
      if (s.loadedAssetId !== null && s.loadedAssetId !== HERO_ASSET_ID) return importedGroup;
      const stage = s.pipelineStage;
      return stage === 'rig' || stage === 'animate' ? rigModel : meshModel;
    };
    const onExport = (req: ViewerExportRequest): void => {
      const root = exportRoot();
      if (root === null) return;
      const base = req.fileName.replace(/\.[a-z0-9]+$/i, '');
      if (req.format === 'GLB') {
        new GLTFExporter().parse(
          root,
          (out) => {
            if (out instanceof ArrayBuffer) downloadBlob(out, `${base}.glb`, 'model/gltf-binary');
            else downloadBlob(JSON.stringify(out), `${base}.gltf`, 'model/gltf+json');
          },
          () => {},
          { binary: true },
        );
      } else if (req.format === 'OBJ') {
        downloadBlob(new OBJExporter().parse(root), `${base}.obj`, 'text/plain');
      } else if (req.format === 'STL') {
        const out = new STLExporter().parse(root, { binary: true });
        downloadBlob(out as unknown as BlobPart, `${base}.stl`, 'model/stl');
      } else {
        void (async () => {
          const out = await new USDZExporter().parseAsync(root);
          downloadBlob(out as unknown as BlobPart, `${base}.usdz`, 'model/vnd.usdz+zip');
        })();
      }
      host.dataset.tpExported = `${base}.${req.format.toLowerCase()}`;
    };
    setViewerExportHandler(onExport);

    /** Re-resolve every themed color (mount, store change, theme flip). */
    const applyPalette = () => {
      const clay = resolveColor('var(--tp-clay-2)');
      clayMat.color.set(clay);
      wireMat.color.set(resolveColor('var(--pd-accent-primary)'));
      texMat.color.set('#ffffff');

      const gm = grid.material as InstanceType<typeof THREE.LineBasicMaterial>;
      gm.color.set(resolveColor('var(--pd-border-strong)'));
      gm.transparent = true;
      gm.opacity = 0.5;
      const qm = quadWire.material as InstanceType<typeof THREE.LineBasicMaterial>;
      qm.color.set(resolveColor('var(--pd-accent-primary)'));
      if (importedWire !== null) {
        importedWire.traverse((o) => {
          const line = o as InstanceType<typeof THREE.LineSegments>;
          if (
            line.isLine === true ||
            (line as { isLineSegments?: boolean }).isLineSegments === true
          ) {
            (line.material as InstanceType<typeof THREE.LineBasicMaterial>).color.set(
              resolveColor('var(--pd-accent-primary)'),
            );
          }
        });
      }
      if (skeletonHelper !== null) {
        (skeletonHelper.material as InstanceType<typeof THREE.LineBasicMaterial>).color.set(
          resolveColor('var(--pd-accent-primary)'),
        );
      }
      const accent = resolveColor('var(--pd-accent-primary)');
      for (const bead of boneJoints) {
        (bead.material as InstanceType<typeof THREE.MeshBasicMaterial>).color.set(accent);
      }
      hemi.color.set(resolveColor('var(--pd-text-primary)'));
      hemi.groundColor.set(resolveColor('var(--pd-bg-inset)'));
    };

    /** The render-mode material for non-segment stages. */
    const modeMaterial = (assetId: string): InstanceType<typeof THREE.Material> => {
      const s = useTripoStore.getState();
      switch (s.renderMode) {
        case 'normal':
          return normalMat;
        case 'wireframe':
          return wireMat;
        case 'textured':
          texMat.map = texturedAssets.has(assetId) ? generatedTexture : null;
          texMat.needsUpdate = true;
          return texMat;
        default:
          return clayMat;
      }
    };

    /** Push the store's viewer + pipeline state into the scene. */
    const applyState = () => {
      const s = useTripoStore.getState();
      const stage = s.pipelineStage;
      const assetId = s.loadedAssetId ?? HERO_ASSET_ID;
      const isImported = assetId !== HERO_ASSET_ID;

      // Imported assets are loaded lazily on first selection.
      if (isImported && assetId !== importedId) {
        void loadImported(assetId);
      }

      // The texture stage marks this asset as textured (Textured mode maps it).
      if (stage === 'texture') texturedAssets.add(assetId);

      // Which model is on screen.
      const showImported = isImported && importedId === assetId;
      if (importedGroup !== null) importedGroup.visible = showImported && s.meshVisible;
      if (importedWire !== null)
        importedWire.visible = showImported && stage === 'retopo' && s.meshVisible;
      const heroMeshVisible =
        !showImported && (stage === 'mesh' || stage === 'segment' || stage === 'texture');
      if (meshModel !== null) meshModel.visible = heroMeshVisible && s.meshVisible;
      if (rigModel !== null)
        rigModel.visible =
          !showImported &&
          (stage === 'retopo' || stage === 'rig' || stage === 'animate') &&
          s.meshVisible;
      quadWire.visible = !showImported && stage === 'retopo' && s.meshVisible;
      const showSkel = !showImported && (stage === 'rig' || (stage === 'animate' && s.skeleton));
      if (skeletonHelper !== null) skeletonHelper.visible = showSkel;
      for (const bead of boneJoints) bead.visible = showSkel;

      // Materials: segment stage paints vertex-color parts; other stages follow
      // the render mode.
      const activeBodies = showImported ? importedBodies : heroMeshVisible ? meshBodies : rigBodies;
      if (stage === 'segment') {
        for (const { mesh } of activeBodies) {
          if (!segPainted.has(mesh.geometry)) {
            paintSegmentColors(mesh.geometry);
            segPainted.add(mesh.geometry);
          }
          mesh.material = segMat;
        }
        const parts = showImported ? ['Top', 'Middle', 'Base'] : ['Head', 'Body', 'Base'];
        if (s.segmentParts.length !== parts.length) {
          useTripoStore.getState().set('segmentParts', parts);
        }
      } else {
        const mat = modeMaterial(assetId);
        for (const { mesh } of activeBodies) mesh.material = mat;
      }

      // Real topology stats for what is on screen.
      let faces = 0;
      let verts = 0;
      for (const { mesh } of activeBodies) {
        const g = mesh.geometry;
        faces += Math.floor(
          (g.index !== null ? g.index.count : g.getAttribute('position').count) / 3,
        );
        verts += g.getAttribute('position').count;
      }
      const stats =
        !showImported && (stage === 'retopo' || stage === 'rig' || stage === 'animate')
          ? { topology: 'Quad', faces: 320, vertices: 336 } // the bundled quad remesh
          : { topology: 'Triangle', faces, vertices: verts };
      const prev = s.stats;
      if (prev === null || prev.faces !== stats.faces || prev.topology !== stats.topology) {
        useTripoStore.getState().set('stats', stats);
      }

      // Animation: play the mapped clip in the animate stage; otherwise reset
      // the skeleton to its bind pose so rig/retopo/mesh read as a still model.
      if (!showImported && stage === 'animate' && mixer !== null) {
        const next = actions.get(clipFor(s.selectedAnim)) ?? actions.get('wave') ?? null;
        if (next !== null && next !== current) {
          if (current !== null) current.fadeOut(0.25);
          next.reset().fadeIn(0.25).play();
          current = next;
        } else if (next !== null) {
          next.paused = false;
        }
      } else {
        if (mixer !== null) mixer.stopAllAction();
        current = null;
        if (skinned !== null) skinned.skeleton.pose();
      }

      grid.visible = s.showGrid;
      controls.autoRotate = s.autoRotate;
      controls.autoRotateSpeed = 2.4;
      const intensity = s.lightIntensity / 60; // slider 0..100, 60 = neutral
      key.intensity = 2.2 * intensity;
      rim.intensity = 1.1 * intensity;
      hemi.intensity = 0.5 * Math.max(intensity, 0.25);
      scene.environment = s.envLight ? envTexture : null;

      // A visible sample with no captured preview yet → queue a thumb capture.
      if (!showImported && heroLoaded) {
        const heroAsset = s.assets.find((a) => a.id === HERO_ASSET_ID);
        if (heroAsset !== undefined && heroAsset.thumb === null) pendingThumb = HERO_ASSET_ID;
      }

      host.dataset.tpStage = stage;
      host.dataset.tpRenderMode = s.renderMode;
      host.dataset.tpSkeleton = skeletonHelper?.visible === true ? '1' : '0';
      host.dataset.tpAnim =
        stage === 'animate' && current !== null ? current.getClip().name : 'none';
      applyPalette();
    };
    applyState();

    const unsubscribe = useTripoStore.subscribe(applyState);

    const themeObserver = new MutationObserver(applyPalette);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-flavor', 'data-mode'],
    });

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // ── camera-synced axis gizmo ────────────────────────────────────────────
    const AXES: readonly {
      readonly id: string;
      readonly v: InstanceType<typeof THREE.Vector3>;
    }[] = [
      { id: 'x', v: new THREE.Vector3(1, 0, 0) },
      { id: 'y', v: new THREE.Vector3(0, 1, 0) },
      { id: 'z', v: new THREE.Vector3(0, 0, 1) },
      { id: '-x', v: new THREE.Vector3(-1, 0, 0) },
      { id: '-y', v: new THREE.Vector3(0, -1, 0) },
      { id: '-z', v: new THREE.Vector3(0, 0, -1) },
    ];
    const tmp = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const syncGizmo = () => {
      const gizmo = gizmoRef.current;
      if (gizmo === null) return;
      const r = 26;
      camera.getWorldQuaternion(q).invert();
      for (const axis of AXES) {
        tmp.copy(axis.v).applyQuaternion(q);
        const el = gizmo.querySelector<HTMLElement>(`[data-ax="${axis.id}"]`);
        if (el !== null) {
          el.style.transform = `translate(${tmp.x * r}px, ${-tmp.y * r}px)`;
          el.style.zIndex = String(100 + Math.round(tmp.z * 50));
          el.style.opacity = axis.id.startsWith('-') ? String(0.35 + 0.3 * (tmp.z + 1) * 0.5) : '1';
        }
        const line = gizmo.querySelector<SVGLineElement>(`[data-axline="${axis.id}"]`);
        if (line !== null) {
          line.setAttribute('x2', String(38 + tmp.x * r));
          line.setAttribute('y2', String(38 - tmp.y * r));
        }
      }
    };

    /** Downscaled capture of the just-rendered frame → the asset's preview. */
    const captureThumb = (assetId: string) => {
      const src = renderer.domElement;
      const side = 144;
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      const s = Math.min(src.width, src.height);
      ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, side, side);
      useTripoStore.getState().setAssetThumb(assetId, canvas.toDataURL('image/jpeg', 0.82));
    };

    // ── render loop + frame/fps instrumentation (probe hooks) ───────────────
    const clock = new THREE.Clock();
    let raf = 0;
    let frames = 0;
    let fpsFrames = 0;
    let fpsLast = performance.now();
    const loop = () => {
      const dt = clock.getDelta();
      if (mixer !== null && useTripoStore.getState().pipelineStage === 'animate') {
        mixer.update(dt);
      }
      controls.update();
      renderer.render(scene, camera);
      syncGizmo();
      // Preview capture rides the frame right after the model became visible.
      if (pendingThumb !== null && frames >= 2) {
        const id = pendingThumb;
        const visibleNow =
          id === HERO_ASSET_ID
            ? (meshModel?.visible ?? false) || (rigModel?.visible ?? false)
            : importedGroup?.visible === true && importedId === id;
        if (visibleNow) {
          pendingThumb = null;
          captureThumb(id);
        }
      }
      frames += 1;
      fpsFrames += 1;
      const now = performance.now();
      if (now - fpsLast >= 500) {
        host.dataset.tpFps = String(Math.round((fpsFrames * 1000) / (now - fpsLast)));
        fpsFrames = 0;
        fpsLast = now;
      }
      // Signal readiness only once a real model has rendered a couple of frames.
      if ((heroLoaded || importedId !== null) && frames >= 2) host.dataset.tpCanvasReady = '1';
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      setViewerExportHandler(null);
      cancelAnimationFrame(raf);
      unsubscribe();
      themeObserver.disconnect();
      ro.disconnect();
      controls.dispose();
      if (mixer !== null) mixer.stopAllAction();
      scene.traverse((o) => {
        const mesh = o as InstanceType<typeof THREE.Mesh>;
        const line = o as InstanceType<typeof THREE.LineSegments>;
        if (mesh.isMesh === true || line.isLine === true) {
          mesh.geometry?.dispose();
          const m = mesh.material as InstanceType<typeof THREE.Material> | undefined;
          if (Array.isArray(m)) for (const mm of m) mm.dispose();
          else m?.dispose();
        }
      });
      normalMat.dispose();
      clayMat.dispose();
      wireMat.dispose();
      segMat.dispose();
      texMat.dispose();
      generatedTexture.dispose();
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [gizmoRef]);

  return <div ref={hostRef} className="tp-canvas-host" data-testid="tp-canvas-host" />;
}
