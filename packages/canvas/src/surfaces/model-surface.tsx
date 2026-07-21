import { Button, Spinner } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
// The three.js runtime + addon loaders are imported at module scope ON PURPOSE:
// this surface is consumed through React.lazy, so keeping the heavy imports here
// lets the bundler fold all of three into the lazy chunk — the 3D code never
// touches the main bundle unless a model tab is actually opened.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

/** Formats we can decode; everything else resolves to the error state. */
type ModelFormat = 'GLB' | 'GLTF' | 'OBJ' | 'STL' | 'PLY';
const KNOWN_FORMATS: readonly ModelFormat[] = ['GLB', 'GLTF', 'OBJ', 'STL', 'PLY'];

/** Neutral clay-grey PBR material for geometry-only formats (STL/PLY) that ship
 * no materials of their own — matches the app's muted panel palette. */
function neutralMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.1, roughness: 0.8 });
}

/** Trailing file extension of a `pd-file://` URL, upper-cased, or null. Query
 * and hash are stripped first so `model.glb?v=2` still resolves to GLB. */
function extensionFormat(src: string): ModelFormat | null {
  const clean = src.split(/[?#]/, 1)[0] ?? src;
  const dot = clean.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = clean.slice(dot + 1).toUpperCase();
  return (KNOWN_FORMATS as readonly string[]).includes(ext) ? (ext as ModelFormat) : null;
}

/** Prefer the explicit `type` hint; fall back to sniffing the src extension. */
function resolveFormat(type: string, src: string): ModelFormat | null {
  const hint = type.toUpperCase();
  if (hint && (KNOWN_FORMATS as readonly string[]).includes(hint)) return hint as ModelFormat;
  return extensionFormat(src);
}

/**
 * Decode raw model bytes into an Object3D for the requested format. Each branch
 * parses straight from the buffer (no network — GLB is self-contained, and for
 * external-ref GLTF a parse-from-buffer is a reasonable foundation), then hands
 * back something addable to the scene.
 */
async function buildObject(format: ModelFormat, buffer: ArrayBuffer): Promise<THREE.Object3D> {
  switch (format) {
    case 'GLB':
    case 'GLTF': {
      // GLTFLoader.parse detects the GLB magic vs. JSON itself, so the same
      // ArrayBuffer path serves both. Wrap its callback API in a promise.
      const loader = new GLTFLoader();
      return await new Promise<THREE.Object3D>((resolve, reject) => {
        loader.parse(
          buffer,
          '',
          (gltf) => resolve(gltf.scene),
          (err) => reject(err),
        );
      });
    }
    case 'OBJ': {
      // OBJ is text; decode then parse. OBJLoader already assigns a default
      // material, but honor the contract and backfill any mesh that somehow has
      // none so it stays lit under the PBR rig.
      const loader = new OBJLoader();
      const object = loader.parse(new TextDecoder().decode(buffer));
      object.traverse((child) => {
        if (child instanceof THREE.Mesh && !child.material) child.material = neutralMaterial();
      });
      return object;
    }
    case 'STL': {
      // STL is geometry-only: wrap it in a mesh with the neutral material and
      // synthesize normals when the file omitted them (flat-shaded exports do).
      const geometry = new STLLoader().parse(buffer);
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, neutralMaterial());
    }
    case 'PLY': {
      const geometry = new PLYLoader().parse(buffer);
      // No index means no faces — the PLY is a point cloud, so render it as
      // Points; a solid mesh would collapse to nothing.
      if (geometry.index === null) {
        const material = new THREE.PointsMaterial({
          color: 0x9aa0a6,
          // Screen-space sizing (attenuation off) keeps dots visible whatever
          // the model's world scale happens to be.
          size: 2,
          sizeAttenuation: false,
        });
        return new THREE.Points(geometry, material);
      }
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, neutralMaterial());
    }
  }
}

/** Minimal shape of the scene nodes we need to release GPU memory for. */
interface Disposable3D {
  geometry?: THREE.BufferGeometry;
  material?: THREE.Material | THREE.Material[];
}

/** Dispose a material and any textures it references (map, normalMap, …). */
function disposeMaterial(material: THREE.Material): void {
  const slots = material as unknown as Record<string, unknown>;
  for (const value of Object.values(slots)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}

/** Walk an object tree freeing every geometry, material, and texture. Called
 * before we drop the GL context so a tab switch can't leak GPU resources. */
function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const node = child as unknown as Disposable3D;
    if (node.geometry) node.geometry.dispose();
    const material = node.material;
    if (Array.isArray(material)) for (const m of material) disposeMaterial(m);
    else if (material) disposeMaterial(material);
  });
}

/**
 * Recenter the loaded object on the origin and pull the camera back far enough
 * that its bounding sphere fits in both the vertical AND horizontal FOV (portrait
 * viewports are width-limited), with a little margin so nothing kisses the edge.
 */
function frameObject(
  object: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  // Shift the object so its bounding-box center sits at the origin — orbiting
  // then feels balanced no matter where the source authored its pivot.
  object.position.sub(center);

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = sphere.radius > 0 ? sphere.radius : 1;

  const aspect = camera.aspect > 0 && Number.isFinite(camera.aspect) ? camera.aspect : 1;
  const halfFovY = (camera.fov * Math.PI) / 360;
  const halfFovX = Math.atan(Math.tan(halfFovY) * aspect);
  const distance = Math.max(radius / Math.sin(halfFovY), radius / Math.sin(halfFovX)) * 1.3;

  camera.position.set(0, 0, distance);
  // Re-derive clip planes from the fit distance so tiny and huge models both
  // survive depth precision.
  camera.near = Math.max(distance / 1000, 0.001);
  camera.far = distance * 1000;
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.update();
}

type ModelStatus = 'loading' | 'loaded' | 'error';

export interface ModelSurfaceProps {
  /** pd-file:// URL to fetch the model bytes from (may be undefined). */
  src?: string;
  /** Upper-cased format hint: 'GLB' | 'GLTF' | 'OBJ' | 'STL' | 'PLY' (fallback: infer from src extension). */
  type: string;
  /** Bump to force a refetch of the same src (e.g. file changed on disk). */
  reloadNonce?: number;
  /** Fired when the in-body [Try again] retry runs. */
  onRefresh?: () => void;
  className?: string;
}

/**
 * ModelSurface — the 3D-model preview BODY (the header lives in the per-tab
 * operation bar, like the other surfaces). It fetches the model bytes, decodes
 * them with the right three.js loader, and renders an orbit-controllable,
 * auto-framed scene into a transparent WebGL canvas so the panel background
 * shows through. State is a small loading → loaded | error machine: a spinner
 * while decoding, and MediaPreviewSurface's [Try again] panel on any failure.
 *
 * The whole scene — renderer, controls, RAF loop, ResizeObserver — is built and
 * torn down inside one effect keyed on the src/format/reload triggers, and the
 * teardown disposes every GPU resource plus forces context loss, so switching
 * tabs or reloading never leaks a WebGL context.
 */
export function ModelSurface({
  src,
  type,
  reloadNonce = 0,
  onRefresh,
  className,
}: ModelSurfaceProps) {
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ModelStatus>('loading');
  // `attempt` re-runs the effect on retry without changing src/reloadNonce.
  const [attempt, setAttempt] = useState(0);

  const retry = (): void => {
    setAttempt((n) => n + 1);
    onRefresh?.();
  };

  // Rebuilds the entire scene whenever the source, format, or a reload trigger
  // changes; the cleanup fully disposes the previous one first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce/attempt are refetch triggers, not read in the body.
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    // A missing src can never resolve — fail fast rather than spin forever.
    if (!src) {
      setStatus('error');
      return;
    }

    setStatus('loading');

    // `disposed` guards the async continuation against a teardown that already
    // ran (dep change / unmount); the controller aborts the in-flight fetch.
    let disposed = false;
    const controller = new AbortController();

    // --- Scene scaffolding, built synchronously so cleanup is deterministic
    //     even if the fetch never resolves. ---
    const scene = new THREE.Scene();

    const initialW = host.clientWidth || 1;
    const initialH = host.clientHeight || 1;
    const camera = new THREE.PerspectiveCamera(50, initialW / initialH, 0.01, 2000);
    camera.position.set(0, 0, 5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(initialW, initialH);
    // ACES tone-mapping + sRGB output so glTF PBR colours/textures read the way
    // the exporter intended (default in three, set explicitly for clarity).
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    host.appendChild(renderer.domElement);

    // Image-based lighting: a neutral studio environment map drives PBR
    // reflections. WITHOUT it, metallic-roughness materials (which most textured
    // glTF/GLB models use) render BLACK or flat and their maps look "missing" —
    // this is the fix for "textures aren't rendering". PMREM pre-filters the
    // procedural RoomEnvironment into an env map the whole scene samples.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;

    // Direct lights ON TOP of the IBL for crisp highlights + form (the env map
    // alone is soft/ambient). StandardMaterial is pure black with neither.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x30343a, 0.6);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(4, 6, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-5, -2, -3);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    let raf = 0;
    const animate = (): void => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(host);

    // --- Fetch + decode. OFFLINE app: the ONLY network call is to `src`. ---
    void (async () => {
      try {
        const format = resolveFormat(type, src);
        if (!format) throw new Error(`Unsupported model type: ${type || '(none)'}`);

        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`Failed to fetch model: ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (disposed) return;

        const object = await buildObject(format, buffer);
        // Teardown may have fired while we were decoding — drop what we built.
        if (disposed) {
          disposeObject(object);
          return;
        }

        scene.add(object);
        frameObject(object, camera, controls);
        setStatus('loaded');
      } catch {
        // Our own teardown aborts the fetch; that AbortError isn't a failure.
        if (disposed || controller.signal.aborted) return;
        setStatus('error');
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      controls.dispose();
      disposeObject(scene);
      scene.environment = null;
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [src, type, reloadNonce, attempt]);

  const rootClass = ['pd-model', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      <div className="pd-model-body">
        {/* Stable mount point — kept in the tree across states so the effect's
            ref is always live; the spinner/error render as overlays on top. */}
        <div className="pd-model-canvas" ref={canvasHostRef} />
        {status === 'loading' ? (
          <div className="pd-media-status">
            <Spinner size={24} />
          </div>
        ) : null}
        {status === 'error' ? (
          <div className="pd-media-error" role="alert">
            <p className="pd-media-error-title">Failed to load model</p>
            <Button size="sm" variant="secondary" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
