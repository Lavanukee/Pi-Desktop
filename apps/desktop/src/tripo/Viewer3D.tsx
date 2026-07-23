/**
 * The center 3D viewer — a raw three.js scene that renders the studio's FOUR
 * pipeline stages for the loaded asset, driven by the zustand store. Loaded
 * ONLY through React.lazy so three stays folded into this chunk.
 *
 *   mesh    → the dense, triangulated generated base mesh (solid, shaded).
 *   retopo  → the clean low-poly QUAD remesh with its quad topology revealed.
 *   rig     → the retopo mesh with a real three.js Skeleton overlaid (bind pose).
 *   animate → the rigged SkinnedMesh playing a baked skeletal AnimationClip.
 *
 * HONESTY: the stages are backed by two bundled sample GLBs (hero-glb.ts) —
 * procedurally authored three.js geometry serialized to real binary glTF and
 * decoded here with GLTFLoader.parse, 100% offline. They are NOT the output of
 * the roadmap ML models (TRELLIS / autoremesher / SkinTokens / ARDY); a live
 * model run would replace how these assets are produced, not how they render.
 *
 * Metal / WebGL quality: antialiasing, devicePixelRatio capped at 2, ACES
 * Filmic tone mapping, sRGB output, a PMREM RoomEnvironment for soft image-
 * based lighting, and PCF-soft contact shadows on a ground plane. Scene colors
 * are resolved from the pd token set and re-tint with the app theme.
 */

import { GLTFLoader, OrbitControls, RoomEnvironment, THREE } from '@pi-desktop/canvas/three';
import type { JSX } from 'react';
import { useEffect, useRef } from 'react';
import { HERO_MESH_GLB_B64, HERO_RIG_GLB_B64 } from './assets/hero-glb';
import { type TripoMaterial, useTripoStore } from './store';

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

interface MaterialSpec {
  readonly colorExpr: string;
  readonly metalness: number;
  readonly roughness: number;
}
const MATERIALS: Record<TripoMaterial, MaterialSpec> = {
  default: { colorExpr: 'var(--tp-clay-1)', metalness: 0.05, roughness: 0.55 },
  matte: { colorExpr: 'var(--tp-clay-3)', metalness: 0, roughness: 1 },
  gold: { colorExpr: 'var(--pd-accent-primary)', metalness: 1, roughness: 0.28 },
  chrome: { colorExpr: 'var(--pd-text-primary)', metalness: 1, roughness: 0.08 },
  teal: { colorExpr: 'var(--pd-status-success-fg)', metalness: 0.25, roughness: 0.35 },
};

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

    // Retopo quad-wire overlay (bind pose; toggled on for the retopo stage).
    const quadWire = buildQuadWire();
    quadWire.visible = false;
    scene.add(quadWire);

    const normalMat = new THREE.MeshNormalMaterial();

    // ── pipeline models (filled once the GLBs decode) ───────────────────────
    interface BodyRef {
      readonly mesh: InstanceType<typeof THREE.Mesh>;
      readonly orig: InstanceType<typeof THREE.MeshStandardMaterial>;
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
    // Accent beads parented to each bone so the skeleton reads clearly (drawn
    // over the mesh via depthTest:false); shown for the rig / animate stages.
    const boneJoints: InstanceType<typeof THREE.Mesh>[] = [];
    let loaded = false;
    let disposed = false;

    const collectBodies = (root: InstanceType<typeof THREE.Group>, into: BodyRef[]) => {
      root.traverse((o) => {
        const mesh = o as InstanceType<typeof THREE.Mesh>;
        if (mesh.isMesh === true) {
          mesh.castShadow = true;
          mesh.frustumCulled = false; // skinned bones can push verts past the bbox
          if (mesh.name.startsWith('wyrm')) {
            into.push({
              mesh,
              orig: mesh.material as InstanceType<typeof THREE.MeshStandardMaterial>,
            });
          }
        }
      });
    };

    const loader = new GLTFLoader();
    const parse = (b64: string): Promise<LoadedGLTF> =>
      new Promise((resolve, reject) =>
        loader.parse(base64ToArrayBuffer(b64), '', (g) => resolve(g as unknown as LoadedGLTF), reject),
      );

    void Promise.all([parse(HERO_MESH_GLB_B64), parse(HERO_RIG_GLB_B64)]).then(
      ([meshGltf, rigGltf]) => {
        if (disposed) return;
        meshModel = meshGltf.scene;
        collectBodies(meshModel, meshBodies);
        meshModel.visible = false;
        scene.add(meshModel);

        rigModel = rigGltf.scene;
        collectBodies(rigModel, rigBodies);
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

        loaded = true;
        applyState();
      },
    );

    /** Re-resolve every themed color + material (mount, store change, theme flip). */
    const applyPalette = () => {
      const s = useTripoStore.getState();
      const spec = MATERIALS[s.material];
      const clay = resolveColor('var(--tp-clay-2)');
      const themed = resolveColor(spec.colorExpr);
      const paintBodies = (bodies: BodyRef[]) => {
        for (const { mesh, orig } of bodies) {
          if (s.renderMode === 'normal') {
            mesh.material = normalMat;
            normalMat.wireframe = s.wireframe;
            continue;
          }
          mesh.material = orig;
          if (s.renderMode === 'clay') {
            orig.color.set(clay);
            orig.metalness = 0.02;
            orig.roughness = 0.85;
          } else {
            orig.color.set(themed);
            orig.metalness = spec.metalness;
            orig.roughness = spec.roughness;
          }
          orig.wireframe = s.wireframe;
          orig.needsUpdate = true;
        }
      };
      paintBodies(meshBodies);
      paintBodies(rigBodies);

      const gm = grid.material as InstanceType<typeof THREE.LineBasicMaterial>;
      gm.color.set(resolveColor('var(--pd-border-strong)'));
      gm.transparent = true;
      gm.opacity = 0.5;
      const qm = quadWire.material as InstanceType<typeof THREE.LineBasicMaterial>;
      qm.color.set(resolveColor('var(--pd-accent-primary)'));
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

    /** Push the store's viewer + pipeline state into the scene. */
    const applyState = () => {
      const s = useTripoStore.getState();
      const stage = s.pipelineStage;

      if (meshModel !== null) meshModel.visible = stage === 'mesh' && s.meshVisible;
      if (rigModel !== null) rigModel.visible = stage !== 'mesh' && s.meshVisible;
      quadWire.visible = stage === 'retopo' && s.meshVisible;
      const showSkel = stage === 'rig' || (stage === 'animate' && s.skeleton);
      if (skeletonHelper !== null) skeletonHelper.visible = showSkel;
      for (const bead of boneJoints) bead.visible = showSkel;

      // Animation: play the mapped clip in the animate stage; otherwise reset
      // the skeleton to its bind pose so rig/retopo/mesh read as a still model.
      if (stage === 'animate' && mixer !== null) {
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

      host.dataset.tpStage = stage;
      host.dataset.tpSkeleton = skeletonHelper !== null && skeletonHelper.visible ? '1' : '0';
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
      frames += 1;
      fpsFrames += 1;
      const now = performance.now();
      if (now - fpsLast >= 500) {
        host.dataset.tpFps = String(Math.round((fpsFrames * 1000) / (now - fpsLast)));
        fpsFrames = 0;
        fpsLast = now;
      }
      // Signal readiness only once a real model has rendered a couple of frames.
      if (loaded && frames >= 2) host.dataset.tpCanvasReady = '1';
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true;
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
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [gizmoRef]);

  return <div ref={hostRef} className="tp-canvas-host" data-testid="tp-canvas-host" />;
}
