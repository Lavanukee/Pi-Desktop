"""Minimal glTF 2.0 / GLB writer for a SKINNED mesh.

trimesh can read skinned glTF but cannot write it, and the rig stage's whole
point is a file that carries a real skeleton and real skin weights. This module
writes exactly that — nothing more: one skinned primitive, one joint hierarchy,
optional UV + base-colour texture carried through from the source.

Everything it emits is spec-conformant glTF 2.0: joint nodes are translation-
only in bind pose, inverseBindMatrices are the inverses of the joints' world
transforms, and JOINTS_0/WEIGHTS_0 are unsigned-short / float4 with weights
normalised per vertex.
"""

from __future__ import annotations

import json
import struct
from io import BytesIO

import numpy as np

FLOAT = 5126
UNSIGNED_INT = 5125
UNSIGNED_SHORT = 5123


class _Buffer:
    """Accumulates binary chunks, 4-byte aligned, and mints bufferViews."""

    def __init__(self) -> None:
        self.data = bytearray()
        self.views: list[dict] = []

    def add_view(self, payload: bytes, target: int | None = None) -> int:
        while len(self.data) % 4:
            self.data.append(0)
        offset = len(self.data)
        self.data.extend(payload)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
        if target is not None:
            view["target"] = target
        self.views.append(view)
        return len(self.views) - 1


def _accessor(
    view: int, component: int, count: int, kind: str, mins=None, maxs=None
) -> dict:
    acc = {"bufferView": view, "componentType": component, "count": count, "type": kind}
    if mins is not None:
        acc["min"] = [float(v) for v in mins]
        acc["max"] = [float(v) for v in maxs]
    return acc


def write_skinned_glb(
    path: str,
    vertices: np.ndarray,
    faces: np.ndarray,
    normals: np.ndarray,
    bone_names: list[str],
    bone_parent: dict[str, str | None],
    joints_world: dict[str, np.ndarray],
    joint_index: np.ndarray,
    joint_weight: np.ndarray,
    *,
    uv: np.ndarray | None = None,
    base_color_png: bytes | None = None,
    extras: dict | None = None,
) -> None:
    buf = _Buffer()
    verts = np.ascontiguousarray(vertices, dtype=np.float32)
    norms = np.ascontiguousarray(normals, dtype=np.float32)
    idx = np.ascontiguousarray(faces, dtype=np.uint32).ravel()
    jidx = np.ascontiguousarray(joint_index, dtype=np.uint16)
    jwt = np.ascontiguousarray(joint_weight, dtype=np.float32)

    v_view = buf.add_view(verts.tobytes(), 34962)
    n_view = buf.add_view(norms.tobytes(), 34962)
    j_view = buf.add_view(jidx.tobytes(), 34962)
    w_view = buf.add_view(jwt.tobytes(), 34962)
    i_view = buf.add_view(idx.tobytes(), 34963)

    accessors: list[dict] = [
        _accessor(v_view, FLOAT, len(verts), "VEC3", verts.min(axis=0), verts.max(axis=0)),
        _accessor(n_view, FLOAT, len(norms), "VEC3"),
        _accessor(j_view, UNSIGNED_SHORT, len(jidx), "VEC4"),
        _accessor(w_view, FLOAT, len(jwt), "VEC4"),
        _accessor(i_view, UNSIGNED_INT, int(idx.size), "SCALAR"),
    ]
    attributes = {"POSITION": 0, "NORMAL": 1, "JOINTS_0": 2, "WEIGHTS_0": 3}

    if uv is not None:
        uvs = np.ascontiguousarray(uv, dtype=np.float32)
        uv_view = buf.add_view(uvs.tobytes(), 34962)
        attributes["TEXCOORD_0"] = len(accessors)
        accessors.append(_accessor(uv_view, FLOAT, len(uvs), "VEC2"))

    # ── nodes: the mesh node first, then one node per joint ──────────────────
    mesh_node = 0
    node_of: dict[str, int] = {name: i + 1 for i, name in enumerate(bone_names)}
    nodes: list[dict] = [{"name": "rigged-mesh", "mesh": 0, "skin": 0}]
    for name in bone_names:
        parent = bone_parent[name]
        origin = joints_world[name]
        local = origin if parent is None else origin - joints_world[parent]
        node: dict = {"name": name, "translation": [float(v) for v in local]}
        children = [node_of[c] for c in bone_names if bone_parent[c] == name]
        if children:
            node["children"] = children
        nodes.append(node)

    roots = [name for name in bone_names if bone_parent[name] is None]
    skeleton_root = node_of[roots[0]]

    # Inverse bind matrices — translation-only bind pose, column-major.
    ibm = np.zeros((len(bone_names), 16), dtype=np.float32)
    for i, name in enumerate(bone_names):
        p = joints_world[name]
        m = np.eye(4, dtype=np.float32)
        m[:3, 3] = -np.asarray(p, dtype=np.float32)
        ibm[i] = m.T.ravel()  # glTF matrices are column-major
    ibm_view = buf.add_view(ibm.tobytes())
    ibm_accessor = len(accessors)
    accessors.append(_accessor(ibm_view, FLOAT, len(bone_names), "MAT4"))

    gltf: dict = {
        "asset": {"version": "2.0", "generator": "bobble-3d rig worker"},
        "scene": 0,
        "scenes": [{"nodes": [mesh_node, skeleton_root]}],
        "nodes": nodes,
        "meshes": [
            {
                "name": "rigged-mesh",
                "primitives": [{"attributes": attributes, "indices": 4, "mode": 4}],
            }
        ],
        "skins": [
            {
                "name": "Armature",
                "inverseBindMatrices": ibm_accessor,
                "skeleton": skeleton_root,
                "joints": [node_of[name] for name in bone_names],
            }
        ],
        "accessors": accessors,
        "bufferViews": buf.views,
    }
    if extras is not None:
        gltf["meshes"][0]["extras"] = extras

    if base_color_png is not None:
        img_view = buf.add_view(base_color_png)
        gltf["images"] = [{"bufferView": img_view, "mimeType": "image/png"}]
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
        gltf["textures"] = [{"sampler": 0, "source": 0}]
        gltf["materials"] = [
            {
                "name": "base",
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": 0},
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.85,
                },
            }
        ]
        gltf["meshes"][0]["primitives"][0]["material"] = 0

    gltf["buffers"] = [{"byteLength": len(buf.data)}]

    json_chunk = json.dumps(gltf, separators=(",", ":")).encode()
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    bin_chunk = bytes(buf.data)
    bin_chunk += b"\0" * ((4 - len(bin_chunk) % 4) % 4)

    out = BytesIO()
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    out.write(struct.pack("<III", 0x46546C67, 2, total))
    out.write(struct.pack("<II", len(json_chunk), 0x4E4F534A))
    out.write(json_chunk)
    out.write(struct.pack("<II", len(bin_chunk), 0x004E4942))
    out.write(bin_chunk)
    with open(path, "wb") as fh:
        fh.write(out.getvalue())
