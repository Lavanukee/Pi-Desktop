/**
 * Build-time generator for the 3D Studio's bundled sample assets.
 *
 * IMPORTANT — HONESTY NOTE: these GLBs are NOT the output of any ML model
 * (TRELLIS / autoremesher / SkinTokens / ARDY). They are procedurally authored
 * three.js geometry, serialized to real binary glTF, and shipped so the studio
 * can VISUALLY DEMONSTRATE each pipeline stage 100% offline. A stage backed by
 * one of these is "sample-asset-backed", not a live generation.
 *
 * It emits ONE creature ("the wyrm") in two forms that share the same profile
 * so they read as the same subject at different topologies:
 *   • MESH_GLB  — a dense, triangulated base mesh (the "generated mesh" stage).
 *   • RIG_GLB   — a clean, low-poly QUAD-grid mesh, skinned to a bone chain and
 *                 carrying baked animation clips (retopo / rig / animate stages).
 *
 * Run (from the repo root or anywhere three resolves):
 *   node apps/desktop/src/tripo/assets/build-hero-glb.mjs
 * Output (committed): apps/desktop/src/tripo/assets/hero-glb.ts
 *
 * This script is a manual build tool — it is never imported by the app and is
 * excluded from tsc/vite (it is a .mjs, not a .ts).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// GLTFExporter's binary path reads a Blob through FileReader (a browser API).
// Node has Blob but not FileReader; a minimal shim covers the one call site.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((ab) => {
      this.result = ab;
      if (typeof this.onloadend === 'function') this.onloadend();
    });
  }
};

// ── shared creature profile ───────────────────────────────────────────────
const Y_TAIL = -1.35;
const Y_NECK = 1.15;
const SPAN = Y_NECK - Y_TAIL;
/** Body radius along the length param t∈[0,1] (tail→neck): a smooth gaussian
 * belly so the wyrm is thin at the tail, full mid-body, tapering into a neck. */
function radiusAt(t) {
  const belly = Math.exp(-(((t - 0.4) / 0.34) ** 2));
  return 0.14 + 0.5 * belly;
}
function yAt(t) {
  return Y_TAIL + SPAN * t;
}

/**
 * Build a tube of revolution around the +Y spine with `rings` height segments
 * and `radial` sides. Shares the seam column (watertight, smooth normals).
 * Returns { geometry, ts } — ts maps each vertex to its length param t.
 */
function buildBody(rings, radial) {
  const positions = [];
  const ts = [];
  const idx = (i, j) => i * radial + (j % radial);
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const y = yAt(t);
    const r = radiusAt(t);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      positions.push(Math.cos(a) * r, y, Math.sin(a) * r);
      ts.push(t);
    }
  }
  // tail cap centre
  const tailCentre = positions.length / 3;
  positions.push(0, yAt(0) - 0.06, 0);
  ts.push(0);

  const indices = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const a = idx(i, j);
      const b = idx(i, j + 1);
      const c = idx(i + 1, j);
      const d = idx(i + 1, j + 1);
      indices.push(a, c, b, b, c, d);
    }
  }
  for (let j = 0; j < radial; j++) {
    indices.push(tailCentre, idx(0, j), idx(0, j + 1));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, ts };
}

/** A small skull + snout + two eyes, placed at the neck top (local origin). */
function buildHead() {
  const group = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0x6f8f7a,
    roughness: 0.62,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.34, 28, 20), skinMat.clone());
  skull.name = 'wyrm_skull';
  skull.scale.set(1, 1.05, 1.28);
  skull.position.set(0, 0.32, 0.06);
  group.add(skull);
  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 20), skinMat.clone());
  snout.name = 'wyrm_snout';
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, 0.27, 0.42);
  group.add(snout);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x14100c,
    roughness: 0.25,
    metalness: 0.1,
  });
  for (const [i, sx] of [-1, 1].entries()) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.062, 14, 12), eyeMat);
    eye.name = `eye_${i}`;
    eye.position.set(sx * 0.16, 0.4, 0.24);
    group.add(eye);
  }
  return group;
}

/** Dorsal spikes, each tagged with the length param t it sits at. */
function buildSpikes() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8a5a3c,
    roughness: 0.5,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });
  const spikes = [];
  const count = 7;
  for (let k = 0; k < count; k++) {
    const t = 0.22 + (k / (count - 1)) * 0.66;
    const r = radiusAt(t);
    const h = 0.12 + 0.18 * Math.exp(-(((t - 0.45) / 0.3) ** 2));
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.05, h, 8), mat.clone());
    cone.name = `wyrm_spike_${k}`;
    cone.position.set(0, yAt(t), -r * 0.92);
    cone.rotation.x = -0.5;
    spikes.push({ mesh: cone, t });
  }
  return spikes;
}

// ── MESH stage: dense triangulated base mesh ──────────────────────────────
function buildMeshScene() {
  const scene = new THREE.Scene();
  const { geometry } = buildBody(150, 72);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6f8f7a,
    roughness: 0.6,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const body = new THREE.Mesh(geometry, mat);
  body.name = 'wyrm_mesh';
  scene.add(body);

  const head = buildHead();
  head.position.y = Y_NECK;
  scene.add(head);
  for (const { mesh } of buildSpikes()) scene.add(mesh);
  return scene;
}

// ── RIG stage: clean quad grid, skinned, animated ─────────────────────────
const RINGS = 20;
const RADIAL = 16;
const BONE_COUNT = 9;

function buildRigScene() {
  const scene = new THREE.Scene();
  const { geometry, ts } = buildBody(RINGS, RADIAL);

  const bones = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const bone = new THREE.Bone();
    bone.name = `spine_${i}`;
    if (i === 0) {
      bone.position.set(0, Y_TAIL, 0);
    } else {
      bone.position.set(0, SPAN / (BONE_COUNT - 1), 0);
      bones[i - 1].add(bone);
    }
    bones.push(bone);
  }

  // skin weights: blend the two nearest spine bones by length param t
  const skinIndices = [];
  const skinWeights = [];
  const segLen = 1 / (BONE_COUNT - 1);
  for (let v = 0; v < ts.length; v++) {
    const f = ts[v] / segLen;
    const lo = Math.min(BONE_COUNT - 2, Math.max(0, Math.floor(f)));
    const frac = Math.min(1, Math.max(0, f - lo));
    skinIndices.push(lo, lo + 1, 0, 0);
    skinWeights.push(1 - frac, frac, 0, 0);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  const mat = new THREE.MeshStandardMaterial({
    color: 0x6f8f7a,
    roughness: 0.6,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.SkinnedMesh(geometry, mat);
  mesh.name = 'wyrm_rig';
  const skeleton = new THREE.Skeleton(bones);
  mesh.add(bones[0]);
  mesh.bind(skeleton);
  scene.add(mesh);

  // head rides the top bone; spikes ride their nearest bone (rigid children)
  const head = buildHead();
  bones[BONE_COUNT - 1].add(head);
  for (const { mesh: spike, t } of buildSpikes()) {
    const bi = Math.min(BONE_COUNT - 1, Math.round(t * (BONE_COUNT - 1)));
    spike.position.set(
      spike.position.x,
      spike.position.y - yAt(bi / (BONE_COUNT - 1)),
      spike.position.z,
    );
    bones[bi].add(spike);
  }

  const clips = buildClips(bones);
  return { scene, clips };
}

/** Procedural bone-rotation clips → a travelling wave along the spine. */
function buildClips(bones) {
  const sampleClip = (name, duration, ampZ, ampX, waves) => {
    const K = 28;
    const tracks = [];
    for (let b = 1; b < bones.length; b++) {
      const phase = (b / bones.length) * Math.PI * 2 * waves;
      const times = [];
      const values = [];
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      for (let k = 0; k <= K; k++) {
        const u = k / K;
        times.push(u * duration);
        const s = Math.sin(u * Math.PI * 2 - phase);
        const c = Math.cos(u * Math.PI * 2 - phase);
        e.set(ampX * c, 0, ampZ * s);
        q.setFromEuler(e);
        values.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bones[b].name}.quaternion`, times, values));
    }
    return new THREE.AnimationClip(name, duration, tracks);
  };
  return [
    sampleClip('idle', 3.2, 0.06, 0.03, 1),
    sampleClip('wave', 2.2, 0.26, 0.08, 1.4),
    sampleClip('coil', 2.6, 0.42, 0.14, 2),
  ];
}

// ── serialize both to base64 GLB ──────────────────────────────────────────
function exportGLB(input, animations) {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      input,
      (result) => resolve(Buffer.from(result).toString('base64')),
      (err) => reject(err),
      { binary: true, animations: animations ?? [] },
    );
  });
}

const meshScene = buildMeshScene();
const { scene: rigScene, clips } = buildRigScene();

const meshB64 = await exportGLB(meshScene, []);
const rigB64 = await exportGLB(rigScene, clips);

const out = `/**
 * GENERATED FILE — do not edit by hand. Produced by build-hero-glb.mjs.
 *
 * Two real binary glTF assets (base64-inlined so they ship inside the Viewer3D
 * lazy chunk with ZERO network and ZERO disk access), decoded at runtime with
 * GLTFLoader.parse. They are procedurally authored three.js geometry — NOT the
 * output of any ML model — used to visually demonstrate the studio pipeline.
 *
 *   HERO_MESH_GLB_B64 — dense triangulated base mesh (mesh-generation stage).
 *   HERO_RIG_GLB_B64  — clean quad grid, skinned + animated (retopo/rig/animate).
 *
 * Clip names in HERO_RIG_GLB_B64: ${clips.map((c) => c.name).join(', ')}.
 */
export const HERO_RIG_CLIPS = ${JSON.stringify(clips.map((c) => c.name))} as const;
export const HERO_MESH_GLB_B64 =
  '${meshB64}';
export const HERO_RIG_GLB_B64 =
  '${rigB64}';
`;

// Node resolves the bare `three` specifier from THIS file's directory. Under
// pnpm's strict layout only the canvas package can resolve three, so this
// script is run from a copy placed there, writing back to an explicit path
// (argv[2]); by default it emits next to itself.
const outPath =
  process.argv[2] !== undefined
    ? path.resolve(process.argv[2])
    : path.join(path.dirname(fileURLToPath(import.meta.url)), 'hero-glb.ts');
writeFileSync(outPath, out);
console.log(
  `wrote ${outPath}\n  mesh GLB ${((meshB64.length * 3) / 4 / 1024).toFixed(1)} KB` +
    `  rig GLB ${((rigB64.length * 3) / 4 / 1024).toFixed(1)} KB` +
    `  clips: ${clips.map((c) => c.name).join(', ')}`,
);
