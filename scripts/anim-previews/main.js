import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const W = 320;
const H = 400;
const loader = new FBXLoader();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#26262c');
const camera = new THREE.PerspectiveCamera(33, W / H, 0.1, 50);
camera.position.set(0.25, 1.05, 3.6);
camera.lookAt(0, 0.92, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x333340, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(2, 4, 3);
scene.add(key);
const rim = new THREE.DirectionalLight(0x99aaff, 1.0);
rim.position.set(-2.5, 2, -2.5);
scene.add(rim);
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(2.4, 48),
  new THREE.MeshStandardMaterial({ color: '#1d1d22', roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

let mixer = null;
let dummyObj = null;
let danceObj = null;
let danceMixer = null;
const bones = new Map();
let danceClip = null;
let embeddedClip = null;
const rest = {};

window.__load = async () => {
  const obj = await loader.loadAsync('/model.fbx');
  obj.scale.setScalar(0.01);
  obj.traverse((o) => {
    if (o.isBone && !bones.has(o.name)) bones.set(o.name, o);
    if (o.isMesh) {
      o.material = new THREE.MeshStandardMaterial({ color: '#b9bac2', roughness: 0.65, metalness: 0.05 });
      o.frustumCulled = false;
    }
  });
  scene.add(obj);
  dummyObj = obj;
  embeddedClip = obj.animations.find((a) => a.duration > 0.5) ?? null;
  // The dance FBX carries its OWN skinned character — cross-rig quaternion
  // copying contorts (different rest orientations), so dance_01 plays the
  // dance character natively instead of retargeting.
  const dance = await loader.loadAsync('/dance.fbx');
  danceClip = dance.animations[0] ?? null;
  dance.scale.setScalar(0.01);
  dance.traverse((o) => {
    if (o.isMesh) {
      o.material = new THREE.MeshStandardMaterial({ color: '#b9bac2', roughness: 0.65, metalness: 0.05 });
      o.frustumCulled = false;
    }
  });
  dance.visible = false;
  scene.add(dance);
  danceObj = dance;
  danceMixer = new THREE.AnimationMixer(dance);
  mixer = new THREE.AnimationMixer(obj);
  for (const [name, b] of bones) rest[name] = b.quaternion.clone();
  renderer.render(scene, camera);
  return { bones: bones.size, dance: danceClip?.duration ?? 0, embedded: embeddedClip?.duration ?? 0 };
};

const D2R = Math.PI / 180;
function track(boneName, dur, fps, fn) {
  const bone = bones.get(boneName);
  if (bone === undefined) return null;
  const r = rest[boneName];
  const times = [];
  const values = [];
  const n = Math.round(dur * fps);
  const e = new THREE.Euler();
  const qd = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    times.push(t * dur);
    const [x, y, z] = fn(t);
    e.set(x * D2R, y * D2R, z * D2R);
    qd.setFromEuler(e);
    q.copy(r).multiply(qd);
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(boneName + '.quaternion', times, values);
}
function posTrack(boneName, dur, fps, fn) {
  const bone = bones.get(boneName);
  if (bone === undefined) return null;
  const base = bone.position.clone();
  const times = [];
  const values = [];
  const n = Math.round(dur * fps);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    times.push(t * dur);
    const [dx, dy, dz] = fn(t);
    values.push(base.x + dx, base.y + dy, base.z + dz);
  }
  return new THREE.VectorKeyframeTrack(boneName + '.position', times, values);
}
const S = (t, f = 1, ph = 0) => Math.sin(t * Math.PI * 2 * f + ph);

function makeClip(preset) {
  const dur = 1.6;
  const fps = 30;
  const T = [];
  const add = (tr) => tr !== null && T.push(tr);
  switch (preset) {
    case 'wave':
    case 'hello':
      add(track('mixamorigRightArm', dur, fps, () => [0, 0, -145]));
      add(track('mixamorigRightForeArm', dur, fps, (t) => [0, 0, -20 + 28 * S(t, 2)]));
      add(track('mixamorigHead', dur, fps, (t) => [0, 8 * S(t, 1), 0]));
      break;
    case 'agree':
      add(track('mixamorigHead', dur, fps, (t) => [16 * Math.abs(S(t, 2)), 0, 0]));
      add(track('mixamorigNeck', dur, fps, (t) => [6 * Math.abs(S(t, 2)), 0, 0]));
      break;
    case 'angry_01':
    case 'angry_02': {
      const m = preset === 'angry_02' ? 1.4 : 1;
      add(track('mixamorigRightArm', dur, fps, () => [0, 0, -55 * m]));
      add(track('mixamorigLeftArm', dur, fps, () => [0, 0, 55 * m]));
      add(track('mixamorigRightForeArm', dur, fps, () => [0, 0, -95]));
      add(track('mixamorigLeftForeArm', dur, fps, () => [0, 0, 95]));
      add(track('mixamorigHead', dur, fps, (t) => [6, 14 * S(t, 3), 0]));
      break;
    }
    case 'afraid':
      add(track('mixamorigSpine', dur, fps, (t) => [18 + 2 * S(t, 2), 0, 0]));
      add(track('mixamorigRightArm', dur, fps, () => [0, 0, -30]));
      add(track('mixamorigLeftArm', dur, fps, () => [0, 0, 30]));
      add(track('mixamorigRightForeArm', dur, fps, () => [0, 0, -120]));
      add(track('mixamorigLeftForeArm', dur, fps, () => [0, 0, 120]));
      add(track('mixamorigHead', dur, fps, (t) => [10, 5 * S(t, 4), 0]));
      break;
    case 'cheer':
      add(track('mixamorigRightArm', dur, fps, (t) => [0, 0, -160 - 8 * S(t, 2)]));
      add(track('mixamorigLeftArm', dur, fps, (t) => [0, 0, 160 + 8 * S(t, 2)]));
      add(posTrack('mixamorigHips', dur, fps, (t) => [0, 8 * Math.abs(S(t, 2)), 0]));
      break;
    case 'clap':
      add(track('mixamorigRightArm', dur, fps, () => [0, 0, -70]));
      add(track('mixamorigLeftArm', dur, fps, () => [0, 0, 70]));
      add(track('mixamorigRightForeArm', dur, fps, (t) => [0, -35 - 30 * S(t, 3), -60]));
      add(track('mixamorigLeftForeArm', dur, fps, (t) => [0, 35 + 30 * S(t, 3), 60]));
      break;
    case 'idle':
      add(track('mixamorigSpine', dur, fps, (t) => [2 * S(t, 1), 0, 1.5 * S(t, 1)]));
      add(track('mixamorigHead', dur, fps, (t) => [2 * S(t, 1, 1), 4 * S(t, 0.5), 0]));
      add(posTrack('mixamorigHips', dur, fps, (t) => [0, 1.2 * S(t, 1), 0]));
      break;
    case 'jump':
      add(posTrack('mixamorigHips', dur, fps, (t) => [0, Math.max(0, 26 * S(t, 1)) - 6 * Math.max(0, S(t, 1, Math.PI)), 0]));
      add(track('mixamorigRightUpLeg', dur, fps, (t) => [Math.max(0, -40 * S(t, 1, Math.PI)), 0, 0]));
      add(track('mixamorigLeftUpLeg', dur, fps, (t) => [Math.max(0, -40 * S(t, 1, Math.PI)), 0, 0]));
      add(track('mixamorigRightArm', dur, fps, (t) => [0, 0, -40 - 50 * Math.max(0, S(t, 1))]));
      add(track('mixamorigLeftArm', dur, fps, (t) => [0, 0, 40 + 50 * Math.max(0, S(t, 1))]));
      break;
    case 'kick':
      add(track('mixamorigRightUpLeg', dur, fps, (t) => [-70 * Math.max(0, S(t, 1)), 0, 0]));
      add(track('mixamorigRightLeg', dur, fps, (t) => [45 * Math.max(0, S(t, 1, 0.6)), 0, 0]));
      add(track('mixamorigSpine', dur, fps, (t) => [-6 * Math.max(0, S(t, 1)), 0, 0]));
      add(track('mixamorigRightArm', dur, fps, () => [0, 0, -35]));
      add(track('mixamorigLeftArm', dur, fps, () => [0, 0, 35]));
      break;
    case 'point':
      add(track('mixamorigRightArm', dur, fps, (t) => [0, -12, -88 + 2 * S(t, 1)]));
      add(track('mixamorigHead', dur, fps, () => [0, -10, 0]));
      break;
    case 'run':
    case 'walk': {
      const f = preset === 'run' ? 2 : 1.25;
      const amp = preset === 'run' ? 42 : 26;
      add(track('mixamorigRightUpLeg', dur, fps, (t) => [amp * S(t, f), 0, 0]));
      add(track('mixamorigLeftUpLeg', dur, fps, (t) => [-amp * S(t, f), 0, 0]));
      add(track('mixamorigRightLeg', dur, fps, (t) => [Math.max(0, 40 * S(t, f, 2.2)), 0, 0]));
      add(track('mixamorigLeftLeg', dur, fps, (t) => [Math.max(0, 40 * S(t, f, 2.2 + Math.PI)), 0, 0]));
      add(track('mixamorigRightArm', dur, fps, (t) => [-amp * 0.7 * S(t, f), 0, preset === 'run' ? -25 : -8]));
      add(track('mixamorigLeftArm', dur, fps, (t) => [amp * 0.7 * S(t, f), 0, preset === 'run' ? 25 : 8]));
      add(track('mixamorigSpine', dur, fps, () => [preset === 'run' ? 10 : 3, 0, 0]));
      add(posTrack('mixamorigHips', dur, fps, (t) => [0, (preset === 'run' ? 5 : 2.5) * Math.abs(S(t, f * 2)), 0]));
      break;
    }
    case 'sad_01':
      add(track('mixamorigHead', dur, fps, (t) => [24 + 2 * S(t, 1), 0, 0]));
      add(track('mixamorigSpine', dur, fps, () => [10, 0, 0]));
      add(track('mixamorigRightShoulder', dur, fps, () => [12, 0, 0]));
      add(track('mixamorigLeftShoulder', dur, fps, () => [12, 0, 0]));
      break;
    default:
      return null;
  }
  // Natural stance: any preset that doesn't animate an arm gets it lowered
  // from the T-pose rest (arms hanging), so posters never read as a T-pose.
  const touches = (b) => T.some((t) => t.name.startsWith(b));
  if (!touches('mixamorigRightArm')) add(track('mixamorigRightArm', dur, fps, () => [0, 0, 68]));
  if (!touches('mixamorigLeftArm')) add(track('mixamorigLeftArm', dur, fps, () => [0, 0, -68]));
  return new THREE.AnimationClip(preset, dur, T);
}

window.__record = async (preset, seconds) => {
  mixer.stopAllAction();
  danceMixer.stopAllAction();
  const useDance = preset === 'dance_01' && danceClip !== null;
  dummyObj.visible = !useDance;
  if (danceObj !== null) danceObj.visible = useDance;
  const m = useDance ? danceMixer : mixer;
  let clip;
  if (useDance) clip = danceClip;
  else {
    clip = makeClip(preset);
    if (clip === null && embeddedClip !== null) clip = embeddedClip;
  }
  const action = m.clipAction(clip);
  action.reset().play();
  m.update(0.0001);
  renderer.render(scene, camera);

  const stream = renderer.domElement.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 900000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = res));
  rec.start();

  let poster = null;
  const t0 = performance.now();
  let last = t0;
  await new Promise((resolve) => {
    const loop = () => {
      const now = performance.now();
      m.update((now - last) / 1000);
      last = now;
      renderer.render(scene, camera);
      const el = (now - t0) / 1000;
      if (poster === null && el >= seconds * 0.4) {
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = 200;
        c.getContext('2d').drawImage(renderer.domElement, 0, 0, 160, 200);
        poster = c.toDataURL('image/jpeg', 0.85);
      }
      if (el >= seconds) return resolve();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  rec.stop();
  await done;
  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
  m.stopAllAction();
  dummyObj.visible = true;
  if (danceObj !== null) danceObj.visible = false;
  return { webmB64: btoa(bin), posterB64: poster };
};
window.__ready = 1;
