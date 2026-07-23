/**
 * The center 3D viewer — a raw three.js scene (torus-knot placeholder mesh,
 * studio lighting, optional grid floor, orbit controls, turntable) that is
 * ONLY ever loaded through React.lazy, so three stays folded into this lazy
 * chunk (`@pi-desktop/canvas/three` bridge; same pattern as the canvas
 * package's model surface).
 *
 * Every scene color is resolved at runtime from the pd token set (via a
 * computed-style probe element), and re-resolved when data-flavor/data-mode
 * flips — the viewer re-tints with the app theme like everything else.
 */

import { OrbitControls, RoomEnvironment, THREE } from '@pi-desktop/canvas/three';
import type { JSX } from 'react';
import { useEffect, useRef } from 'react';
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

export interface Viewer3DProps {
  /** The axis-gizmo DOM to keep in sync (elements tagged data-ax / data-axline). */
  readonly gizmoRef: React.RefObject<HTMLDivElement | null>;
}

export default function Viewer3D({ gizmoRef }: Viewer3DProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  // Imperative three state, driven by store subscription (no React re-render
  // per frame; primitive selectors only).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(3.5, 2.4, 4.3);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.1, 0);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // Studio rig: hemisphere fill + warm key + cool rim.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 4, 2.5);
    const rim = new THREE.DirectionalLight(0xffffff, 1.1);
    rim.position.set(-3.5, 2.5, -3);
    scene.add(hemi, key, rim);

    const geometry = new THREE.TorusKnotGeometry(0.72, 0.25, 260, 40);
    const standard = new THREE.MeshStandardMaterial();
    const normalMat = new THREE.MeshNormalMaterial();
    const mesh = new THREE.Mesh<
      InstanceType<typeof THREE.TorusKnotGeometry>,
      | InstanceType<typeof THREE.MeshStandardMaterial>
      | InstanceType<typeof THREE.MeshNormalMaterial>
    >(geometry, standard);
    mesh.position.y = 0.1;
    scene.add(mesh);

    const grid = new THREE.GridHelper(10, 20);
    grid.position.y = -1.05;
    scene.add(grid);

    /** Re-resolve every themed color (called on mount + theme flips). */
    const applyPalette = () => {
      const s = useTripoStore.getState();
      const spec = MATERIALS[s.material];
      standard.color.set(resolveColor(spec.colorExpr));
      standard.metalness = spec.metalness;
      standard.roughness = spec.roughness;
      if (s.renderMode === 'clay') {
        standard.color.set(resolveColor('var(--tp-clay-2)'));
        standard.metalness = 0.02;
        standard.roughness = 0.85;
      }
      standard.needsUpdate = true;
      const gm = grid.material as THREE.LineBasicMaterial;
      gm.color.set(resolveColor('var(--pd-border-strong)'));
      gm.transparent = true;
      gm.opacity = 0.5;
      hemi.color.set(resolveColor('var(--pd-text-primary)'));
      hemi.groundColor.set(resolveColor('var(--pd-bg-inset)'));
    };

    /** Push the store's viewer prefs into the scene. */
    const applyState = () => {
      const s = useTripoStore.getState();
      standard.wireframe = s.wireframe;
      normalMat.wireframe = s.wireframe;
      mesh.material = s.renderMode === 'normal' ? normalMat : standard;
      mesh.visible = s.meshVisible;
      grid.visible = s.showGrid;
      controls.autoRotate = s.autoRotate;
      controls.autoRotateSpeed = 2.4;
      const intensity = s.lightIntensity / 60; // slider 0..100, 60 = neutral
      key.intensity = 2.2 * intensity;
      rim.intensity = 1.1 * intensity;
      hemi.intensity = 0.5 * Math.max(intensity, 0.25);
      scene.environment = s.envLight ? envTexture : null;
      applyPalette();
    };
    applyState();

    const unsubscribe = useTripoStore.subscribe(applyState);

    // Theme flips re-tint the scene (data-flavor / data-mode on <html>).
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

    // ── camera-synced axis gizmo ─────────────────────────────────────────
    const AXES: readonly { readonly id: string; readonly v: THREE.Vector3 }[] = [
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
      const r = 26; // px radius inside the 76px widget
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

    let raf = 0;
    let frames = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      syncGizmo();
      frames += 1;
      if (frames === 2) host.dataset.tpCanvasReady = '1'; // probe hook: a real frame rendered
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      themeObserver.disconnect();
      ro.disconnect();
      controls.dispose();
      geometry.dispose();
      standard.dispose();
      normalMat.dispose();
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [gizmoRef]);

  return <div ref={hostRef} className="tp-canvas-host" data-testid="tp-canvas-host" />;
}
