"""Write an ANIMATED glTF 2.0 / GLB: a skeleton, and a clip that moves it.

Sibling to _glbskin.py, which writes a skinned mesh in bind pose and nothing
else. Motion generation produces the opposite problem — a hierarchy with a
rotation per joint per frame and no mesh at all — and trimesh cannot write
either one.

IT SHIPS A VISIBLE BODY, not just joint nodes. A GLB containing only an
animated node hierarchy is spec-conformant and renders as an empty scene in
every viewer that does not draw helpers, which makes "did the motion work?"
unanswerable by looking. So each bone also gets a box skinned rigidly to its
parent joint: crude, but it is a figure, and a figure that walks is the point.

Everything here is spec-conformant glTF 2.0: joint nodes are translation-only
in bind pose, inverseBindMatrices invert the joints' world bind transforms, and
the animation is one rotation sampler per joint plus a translation sampler for
the root.
"""

from __future__ import annotations

import json
import struct
from io import BytesIO

import numpy as np

from _glbskin import FLOAT, UNSIGNED_INT, UNSIGNED_SHORT, _accessor, _Buffer

# Half-width of a bone box, in metres. Thin enough to read as a skeleton rather
# than a blob, thick enough to be visible against a background at a distance.
BONE_HALF_WIDTH = 0.022
# Bones whose rest length is below this get no box: cskel27's finger and
# hand-end joints sit millimetres apart, and a box there is noise.
MIN_BONE_LENGTH_M = 0.02


def _quats_from_matrices(mats: np.ndarray) -> np.ndarray:
    """(..., 3, 3) rotation matrices -> (..., 4) xyzw quaternions.

    Shepperd's method: pick the largest diagonal-derived term before dividing,
    so the branch that would divide by ~0 for a 180-degree rotation is never the
    one taken. A naive trace-only formula produces NaN there, and a motion model
    reaches 180-degree relative rotations routinely (a turn, a full arm swing).
    """
    m = np.asarray(mats, dtype=np.float64)
    flat = m.reshape(-1, 3, 3)
    n = flat.shape[0]
    q = np.empty((n, 4), dtype=np.float64)

    trace = flat[:, 0, 0] + flat[:, 1, 1] + flat[:, 2, 2]
    diag = np.stack([flat[:, 0, 0], flat[:, 1, 1], flat[:, 2, 2]], axis=1)
    use_trace = trace > 0.0
    best = np.argmax(diag, axis=1)

    if np.any(use_trace):
        idx = np.where(use_trace)[0]
        s = np.sqrt(trace[idx] + 1.0) * 2.0
        q[idx, 3] = 0.25 * s
        q[idx, 0] = (flat[idx, 2, 1] - flat[idx, 1, 2]) / s
        q[idx, 1] = (flat[idx, 0, 2] - flat[idx, 2, 0]) / s
        q[idx, 2] = (flat[idx, 1, 0] - flat[idx, 0, 1]) / s

    for axis in range(3):
        idx = np.where(~use_trace & (best == axis))[0]
        if idx.size == 0:
            continue
        a, b = (axis + 1) % 3, (axis + 2) % 3
        s = np.sqrt(1.0 + flat[idx, axis, axis] - flat[idx, a, a] - flat[idx, b, b]) * 2.0
        q[idx, 3] = (flat[idx, b, a] - flat[idx, a, b]) / s
        q[idx, axis] = 0.25 * s
        q[idx, a] = (flat[idx, a, axis] + flat[idx, axis, a]) / s
        q[idx, b] = (flat[idx, b, axis] + flat[idx, axis, b]) / s

    q /= np.linalg.norm(q, axis=1, keepdims=True)
    return q.reshape(*m.shape[:-2], 4).astype(np.float32)


def _bone_boxes(rest_world: np.ndarray, parents: list[int]):
    """A box per bone, in REST world space, each rigidly skinned to its parent.

    Returns (vertices, normals, faces, joint_index, joint_weight). Weights are
    all 1 on a single joint: this is a proxy for looking at the motion, not a
    deformable character, and a rigid box per bone is exactly what makes the
    joint rotations legible.
    """
    verts: list[np.ndarray] = []
    norms: list[np.ndarray] = []
    faces: list[np.ndarray] = []
    bound: list[int] = []

    # Unit cube spanning x,z in [-1,1] and y in [0,1]: y is the bone direction,
    # so scaling y by the bone length and orienting +y along the bone lands the
    # box exactly between the two joints.
    cube_v = np.array(
        [
            [-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1],
            [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],
        ],
        dtype=np.float64,
    )
    cube_f = np.array(
        [
            [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
            [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
        ],
        dtype=np.uint32,
    )

    for child, parent in enumerate(parents):
        if parent < 0:
            continue
        start, end = rest_world[parent], rest_world[child]
        direction = end - start
        length = float(np.linalg.norm(direction))
        if length < MIN_BONE_LENGTH_M:
            continue
        y = direction / length
        # Any vector not parallel to the bone works as the seed for an
        # orthonormal frame; picking by smallest component avoids the
        # degenerate cross product when the bone is axis-aligned.
        seed = np.zeros(3)
        seed[int(np.argmin(np.abs(y)))] = 1.0
        x = np.cross(seed, y)
        x /= np.linalg.norm(x)
        z = np.cross(x, y)
        basis = np.stack([x * BONE_HALF_WIDTH, y * length, z * BONE_HALF_WIDTH], axis=1)

        offset = len(verts) * 8
        verts.append(start + cube_v @ basis.T)
        # Flat-ish normals: the box is a proxy, and per-face normals would
        # triple the vertex count for a shape nobody inspects closely.
        n = (cube_v - np.array([0.0, 0.5, 0.0])) @ basis.T
        norms.append(n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9))
        faces.append(cube_f + offset)
        bound.extend([parent] * 8)

    if not verts:
        raise ValueError("no bones long enough to draw")

    v = np.concatenate(verts).astype(np.float32)
    joint_index = np.zeros((len(v), 4), dtype=np.uint16)
    joint_index[:, 0] = np.asarray(bound, dtype=np.uint16)
    joint_weight = np.zeros((len(v), 4), dtype=np.float32)
    joint_weight[:, 0] = 1.0
    return v, np.concatenate(norms).astype(np.float32), np.concatenate(faces), joint_index, joint_weight


def write_animated_glb(
    path: str,
    *,
    bone_names: list[str],
    parents: list[int],
    rest_world: np.ndarray,
    local_rot_mats: np.ndarray,
    root_positions: np.ndarray,
    fps: float,
    name: str = "motion",
    extras: dict | None = None,
) -> None:
    """One skeleton, one clip.

    rest_world       (J, 3)        bind-pose joint positions, world space
    local_rot_mats   (F, J, 3, 3)  per-frame rotation of each joint, parent-local
    root_positions   (F, 3)        per-frame world translation of the root
    """
    rest_world = np.asarray(rest_world, dtype=np.float64)
    local_rot_mats = np.asarray(local_rot_mats, dtype=np.float64)
    root_positions = np.asarray(root_positions, dtype=np.float64)
    num_joints = len(bone_names)
    num_frames = local_rot_mats.shape[0]
    if local_rot_mats.shape[1] != num_joints:
        raise ValueError(f"{local_rot_mats.shape[1]} joints of rotation for {num_joints} bones")

    buf = _Buffer()
    accessors: list[dict] = []

    def add(payload: bytes, component: int, count: int, kind: str, target=None, mins=None, maxs=None) -> int:
        accessors.append(_accessor(buf.add_view(payload, target), component, count, kind, mins, maxs))
        return len(accessors) - 1

    # ---- the visible body -------------------------------------------------
    verts, norms, faces, jidx, jwt = _bone_boxes(rest_world, parents)
    v_acc = add(verts.tobytes(), FLOAT, len(verts), "VEC3", 34962, verts.min(0), verts.max(0))
    n_acc = add(norms.tobytes(), FLOAT, len(norms), "VEC3", 34962)
    j_acc = add(jidx.tobytes(), UNSIGNED_SHORT, len(jidx), "VEC4", 34962)
    w_acc = add(jwt.tobytes(), FLOAT, len(jwt), "VEC4", 34962)
    idx = np.ascontiguousarray(faces, dtype=np.uint32).ravel()
    i_acc = add(idx.tobytes(), UNSIGNED_INT, len(idx), "SCALAR", 34963)

    # inverseBindMatrices: the joints' bind transforms are pure translation, so
    # the inverse is a translation by -position. Column-major, per spec.
    ibm = np.tile(np.eye(4, dtype=np.float32), (num_joints, 1, 1))
    ibm[:, 3, :3] = -rest_world.astype(np.float32)
    ibm_acc = add(np.ascontiguousarray(ibm).tobytes(), FLOAT, num_joints, "MAT4")

    # ---- the clip ---------------------------------------------------------
    times = (np.arange(num_frames, dtype=np.float32) / float(fps)).astype(np.float32)
    t_acc = add(times.tobytes(), FLOAT, num_frames, "SCALAR", mins=[times.min()], maxs=[times.max()])

    quats = _quats_from_matrices(local_rot_mats)  # (F, J, 4)
    samplers: list[dict] = []
    channels: list[dict] = []
    for j in range(num_joints):
        rot = np.ascontiguousarray(quats[:, j, :], dtype=np.float32)
        r_acc = add(rot.tobytes(), FLOAT, num_frames, "VEC4")
        samplers.append({"input": t_acc, "output": r_acc, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": j, "path": "rotation"}})

    # The root also travels. Its node translation in bind pose is its rest
    # position, so the clip carries absolute world positions for it.
    root_t = np.ascontiguousarray(root_positions, dtype=np.float32)
    rt_acc = add(root_t.tobytes(), FLOAT, num_frames, "VEC3")
    samplers.append({"input": t_acc, "output": rt_acc, "interpolation": "LINEAR"})
    channels.append({"sampler": len(samplers) - 1, "target": {"node": 0, "path": "translation"}})

    # ---- the hierarchy ----------------------------------------------------
    nodes: list[dict] = []
    for j, bone in enumerate(bone_names):
        parent = parents[j]
        local = rest_world[j] - (rest_world[parent] if parent >= 0 else np.zeros(3))
        node = {"name": bone, "translation": [float(x) for x in local]}
        kids = [k for k, p in enumerate(parents) if p == j]
        if kids:
            node["children"] = kids
        nodes.append(node)
    mesh_node = len(nodes)
    nodes.append({"name": f"{name}_body", "mesh": 0, "skin": 0})

    gltf = {
        "asset": {"version": "2.0", "generator": "bobble-motion"},
        "scene": 0,
        "scenes": [{"nodes": [0, mesh_node]}],
        "nodes": nodes,
        "meshes": [
            {
                "name": f"{name}_body",
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": v_acc,
                            "NORMAL": n_acc,
                            "JOINTS_0": j_acc,
                            "WEIGHTS_0": w_acc,
                        },
                        "indices": i_acc,
                        "material": 0,
                    }
                ],
            }
        ],
        "materials": [
            {
                "name": "bone",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.82, 0.84, 0.88, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.65,
                },
            }
        ],
        "skins": [{"joints": list(range(num_joints)), "inverseBindMatrices": ibm_acc}],
        "animations": [{"name": name, "samplers": samplers, "channels": channels}],
        "accessors": accessors,
        "bufferViews": buf.views,
        "buffers": [{"byteLength": len(buf.data)}],
    }
    if extras:
        gltf["extras"] = extras

    _write_glb(path, gltf, bytes(buf.data))


def _write_glb(path: str, gltf: dict, binary: bytes) -> None:
    json_chunk = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * (-len(json_chunk) % 4)
    bin_chunk = binary + b"\0" * (-len(binary) % 4)
    out = BytesIO()
    out.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)))
    out.write(struct.pack("<II", len(json_chunk), 0x4E4F534A))
    out.write(json_chunk)
    out.write(struct.pack("<II", len(bin_chunk), 0x004E4942))
    out.write(bin_chunk)
    with open(path, "wb") as fh:
        fh.write(out.getvalue())


# ---------------------------------------------------------------- retarget --


def _read_glb(path: str) -> tuple[dict, bytearray]:
    with open(path, "rb") as fh:
        blob = fh.read()
    magic, _version, _length = struct.unpack_from("<III", blob, 0)
    if magic != 0x46546C67:
        raise ValueError(f"{path} is not a GLB")
    gltf: dict | None = None
    binary = bytearray()
    offset = 12
    while offset < len(blob):
        chunk_len, chunk_type = struct.unpack_from("<II", blob, offset)
        payload = blob[offset + 8 : offset + 8 + chunk_len]
        if chunk_type == 0x4E4F534A:
            gltf = json.loads(payload.decode("utf-8"))
        elif chunk_type == 0x004E4942:
            binary = bytearray(payload)
        offset += 8 + chunk_len + (-chunk_len % 4)
    if gltf is None:
        raise ValueError(f"{path} has no JSON chunk")
    return gltf, binary


def _world_positions(gltf: dict) -> dict[int, np.ndarray]:
    """Every node's world translation, by walking the scene once.

    Only translations are accumulated: joint nodes in a bind pose are
    translation-only by construction (both _glbskin and this module write them
    that way), so a full TRS compose would be ceremony around the same numbers.
    """
    nodes = gltf.get("nodes", [])
    world: dict[int, np.ndarray] = {}

    def walk(index: int, parent: np.ndarray) -> None:
        local = np.asarray(nodes[index].get("translation", [0.0, 0.0, 0.0]), dtype=np.float64)
        here = parent + local
        world[index] = here
        for child in nodes[index].get("children", []):
            walk(int(child), here)

    roots = set(range(len(nodes)))
    for node in nodes:
        for child in node.get("children", []):
            roots.discard(int(child))
    for index in sorted(roots):
        walk(index, np.zeros(3))
    return world


def retarget_into_glb(
    src_path: str,
    dst_path: str,
    *,
    bone_names: list[str],
    local_rot_mats: np.ndarray,
    root_positions: np.ndarray,
    ardy_rest_world: np.ndarray,
    fps: float,
    name: str = "motion",
) -> dict:
    """Write a generated clip INTO an already-rigged GLB, keeping its mesh.

    This is what makes the motion stage useful rather than a curiosity: the rig
    stage produced a character with skin weights and a texture, and the answer
    to "animate it" has to be that character moving — not a stick figure beside
    it.

    NO RETARGETING MATHS IS NEEDED FOR THE POSE. ARDY's cskel27 and the rig
    stage's skeleton are the same joints in the same order (motion_worker.py
    asserts it), and the clip drives LOCAL ROTATIONS, which are proportion-
    independent by construction — a long-limbed character and a short one both
    bend the elbow by the same angle.

    THE ROOT TRANSLATION IS THE EXCEPTION and does need scaling. It is measured
    in metres against ARDY's own body, so a character half its height would take
    ARDY-sized strides on half-sized legs and skate. The ratio is taken on LEG
    LENGTH — hips above the lowest joint — on both bodies, because that is what
    stride length actually scales with, and because it is the only measure that
    survives the two skeletons using different origins: ARDY's rest pose is
    HIPS-RELATIVE (Hips at exactly 0,0,0), so a naive "hip height" reads as
    zero, quietly disables the scaling, and leaves a short character taking
    full-size strides.

    Returns what it did, so the caller can report it rather than assume it.
    """
    gltf, binary = _read_glb(src_path)
    nodes = gltf.get("nodes", [])
    by_name = {node.get("name"): i for i, node in enumerate(nodes)}
    missing = [b for b in bone_names if b not in by_name]
    if missing:
        raise ValueError(
            f"{src_path} has no joint node named {missing[0]!r} "
            f"({len(missing)} of {len(bone_names)} missing) — is it rigged?"
        )

    local_rot_mats = np.asarray(local_rot_mats, dtype=np.float64)
    root_positions = np.asarray(root_positions, dtype=np.float64)
    num_frames = local_rot_mats.shape[0]

    world = _world_positions(gltf)
    hips = by_name[bone_names[0]]
    joint_ys = [float(world[by_name[b]][1]) for b in bone_names]
    character_leg = float(world[hips][1]) - min(joint_ys)
    rest = np.asarray(ardy_rest_world, dtype=np.float64)
    ardy_leg = float(rest[0][1] - rest[:, 1].min())
    # A degenerate rig (every joint at one point, a mesh authored in
    # centimetres) must not scale the motion to nothing or fling it off-world.
    scale = 1.0
    if ardy_leg > 1e-3 and character_leg > 1e-3:
        ratio = character_leg / ardy_leg
        if 0.1 <= ratio <= 10.0:
            scale = ratio

    # Append to the EXISTING buffer rather than rebuilding it: the mesh, its UVs,
    # its texture and its skin weights are already in there and are exactly what
    # must survive.
    accessors = gltf.setdefault("accessors", [])
    views = gltf.setdefault("bufferViews", [])

    def add(payload: bytes, component: int, count: int, kind: str, mins=None, maxs=None) -> int:
        while len(binary) % 4:
            binary.append(0)
        views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(payload)})
        binary.extend(payload)
        accessors.append(_accessor(len(views) - 1, component, count, kind, mins, maxs))
        return len(accessors) - 1

    times = (np.arange(num_frames, dtype=np.float32) / float(fps)).astype(np.float32)
    t_acc = add(times.tobytes(), FLOAT, num_frames, "SCALAR", [times.min()], [times.max()])

    quats = _quats_from_matrices(local_rot_mats)
    samplers: list[dict] = []
    channels: list[dict] = []
    for j, bone in enumerate(bone_names):
        rot = np.ascontiguousarray(quats[:, j, :], dtype=np.float32)
        r_acc = add(rot.tobytes(), FLOAT, num_frames, "VEC4")
        samplers.append({"input": t_acc, "output": r_acc, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": by_name[bone], "path": "rotation"}})

    # The hips node may hang under a parent (an armature root); its animated
    # translation is a LOCAL value, so the parent's world offset comes off first
    # or the character is displaced by however deep its rig is nested.
    parent_offset = world[hips] - np.asarray(
        nodes[hips].get("translation", [0.0, 0.0, 0.0]), dtype=np.float64
    )
    root_local = root_positions * scale - parent_offset
    rt = np.ascontiguousarray(root_local, dtype=np.float32)
    rt_acc = add(rt.tobytes(), FLOAT, num_frames, "VEC3")
    samplers.append({"input": t_acc, "output": rt_acc, "interpolation": "LINEAR"})
    channels.append({"sampler": len(samplers) - 1, "target": {"node": hips, "path": "translation"}})

    # Replace rather than append: re-running the stage should give one clip, not
    # a pile of them fighting over the same joints.
    gltf["animations"] = [{"name": name, "samplers": samplers, "channels": channels}]
    gltf["buffers"] = [{"byteLength": len(binary)}]
    _write_glb(dst_path, gltf, bytes(binary))
    return {
        "scale": round(scale, 4),
        "characterLegLength": round(character_leg, 4),
        "ardyLegLength": round(ardy_leg, 4),
        "frames": num_frames,
        "joints": len(bone_names),
    }
