// Structural GLB validator — dependency-free (three.js's GLTFLoader needs DOM
// shims for textured models in Node, so the renderer e2e owns the visual
// parse; this validates the container the same way a loader's first pass
// does: magic/version, chunk layout, JSON integrity, accessor/buffer bounds).
// Usable as a module (validateGlb) or a CLI: node gen3d-glb-check.mjs file.glb
import { readFileSync } from 'node:fs';

export function validateGlb(buffer) {
  const problems = [];
  if (buffer.length < 20) return { ok: false, problems: ['file too small'] };
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0x46546c67) problems.push('bad magic (not glTF)');
  const version = buffer.readUInt32LE(4);
  if (version !== 2) problems.push(`unsupported glTF version ${version}`);
  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength !== buffer.length)
    problems.push(`length mismatch: header ${declaredLength} vs file ${buffer.length}`);

  const jsonLength = buffer.readUInt32LE(12);
  const jsonType = buffer.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a) problems.push('first chunk is not JSON');
  let json = null;
  try {
    json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  } catch {
    problems.push('JSON chunk does not parse');
  }

  let binLength = 0;
  const binOffset = 20 + jsonLength;
  if (binOffset + 8 <= buffer.length) {
    binLength = buffer.readUInt32LE(binOffset);
    const binType = buffer.readUInt32LE(binOffset + 4);
    if (binType !== 0x004e4942) problems.push('second chunk is not BIN');
  }

  let stats = {};
  if (json !== null) {
    const meshes = json.meshes ?? [];
    const accessors = json.accessors ?? [];
    const bufferViews = json.bufferViews ?? [];
    if (meshes.length === 0) problems.push('no meshes');
    let triangles = 0;
    let vertices = 0;
    for (const mesh of meshes) {
      for (const prim of mesh.primitives ?? []) {
        const pos = accessors[prim.attributes?.POSITION];
        if (pos === undefined) {
          problems.push('primitive missing POSITION accessor');
          continue;
        }
        vertices += pos.count;
        const idx = accessors[prim.indices];
        triangles += Math.floor((idx?.count ?? pos.count) / 3);
      }
    }
    for (const view of bufferViews) {
      const end = (view.byteOffset ?? 0) + view.byteLength;
      if (end > binLength) problems.push(`bufferView overruns BIN chunk (${end} > ${binLength})`);
    }
    stats = {
      meshes: meshes.length,
      vertices,
      triangles,
      materials: (json.materials ?? []).length,
      textures: (json.textures ?? []).length,
      images: (json.images ?? []).length,
    };
  }
  return { ok: problems.length === 0, problems, stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node gen3d-glb-check.mjs <file.glb>');
    process.exit(2);
  }
  const result = validateGlb(readFileSync(file));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
