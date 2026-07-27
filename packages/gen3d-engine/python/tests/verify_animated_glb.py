"""Play an animated GLB the way a viewer would, and look at the result.

Writing a spec-conformant file and writing a file that ANIMATES are different
achievements, and every tool in the chain will happily accept the first. This
loads the GLB back with no knowledge of how it was made, evaluates the clip at
several times, runs linear blend skinning on the actual vertices, and renders
silhouettes — so "the character moves" is something seen rather than assumed.

It also answers the question a picture cannot: whether the mesh MOVED. A rig
whose animation targets the wrong nodes, or whose inverse bind matrices are
wrong, produces a file that loads, plays, and holds perfectly still.

    python verify_animated_glb.py <animated.glb> --out strip.png
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np

# Component type -> numpy dtype, per glTF 2.0.
DTYPES = {5120: "<i1", 5121: "<u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path: str) -> tuple[dict, bytes]:
    blob = Path(path).read_bytes()
    if struct.unpack_from("<I", blob, 0)[0] != 0x46546C67:
        raise SystemExit(f"{path} is not a GLB")
    gltf, binary, offset = None, b"", 12
    while offset < len(blob):
        length, kind = struct.unpack_from("<II", blob, offset)
        payload = blob[offset + 8 : offset + 8 + length]
        if kind == 0x4E4F534A:
            gltf = json.loads(payload)
        elif kind == 0x004E4942:
            binary = payload
        offset += 8 + length + (-length % 4)
    if gltf is None:
        raise SystemExit("no JSON chunk")
    return gltf, binary


def accessor(gltf: dict, binary: bytes, index: int) -> np.ndarray:
    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    n = COUNTS[acc["type"]]
    data = np.frombuffer(
        binary, dtype=DTYPES[acc["componentType"]], count=acc["count"] * n, offset=start
    )
    return data.reshape(acc["count"], n) if n > 1 else data


def quat_to_matrix(q: np.ndarray) -> np.ndarray:
    x, y, z, w = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def sample_clip(gltf: dict, binary: bytes, t: float) -> dict[int, dict]:
    """Node index -> {rotation, translation} at time t. Nearest keyframe: this
    checks that the data is right, not that interpolation is smooth."""
    out: dict[int, dict] = {}
    for anim in gltf.get("animations", []):
        for channel in anim["channels"]:
            sampler = anim["samplers"][channel["sampler"]]
            times = accessor(gltf, binary, sampler["input"])
            values = accessor(gltf, binary, sampler["output"])
            frame = int(np.argmin(np.abs(np.asarray(times).ravel() - t)))
            out.setdefault(channel["target"]["node"], {})[channel["target"]["path"]] = values[frame]
    return out


def world_matrices(gltf: dict, pose: dict[int, dict]) -> dict[int, np.ndarray]:
    nodes = gltf["nodes"]
    world: dict[int, np.ndarray] = {}

    def walk(index: int, parent: np.ndarray) -> None:
        node = nodes[index]
        posed = pose.get(index, {})
        translation = posed.get("translation", node.get("translation", [0.0, 0.0, 0.0]))
        rotation = posed.get("rotation", node.get("rotation", [0.0, 0.0, 0.0, 1.0]))
        local = np.eye(4)
        local[:3, :3] = quat_to_matrix(np.asarray(rotation, dtype=np.float64))
        local[:3, 3] = np.asarray(translation, dtype=np.float64)
        here = parent @ local
        world[index] = here
        for child in node.get("children", []):
            walk(int(child), here)

    roots = set(range(len(nodes)))
    for node in nodes:
        for child in node.get("children", []):
            roots.discard(int(child))
    for index in sorted(roots):
        walk(index, np.eye(4))
    return world


def skin_at(gltf: dict, binary: bytes, t: float) -> np.ndarray:
    """Vertices of the skinned primitive, posed at time t (linear blend)."""
    mesh_node = next(n for n in gltf["nodes"] if "mesh" in n and "skin" in n)
    prim = gltf["meshes"][mesh_node["mesh"]]["primitives"][0]
    positions = accessor(gltf, binary, prim["attributes"]["POSITION"]).astype(np.float64)
    joints = accessor(gltf, binary, prim["attributes"]["JOINTS_0"]).astype(int)
    weights = accessor(gltf, binary, prim["attributes"]["WEIGHTS_0"]).astype(np.float64)

    skin = gltf["skins"][mesh_node["skin"]]
    ibm = accessor(gltf, binary, skin["inverseBindMatrices"]).reshape(-1, 4, 4)
    # glTF matrices are COLUMN-major; numpy reads them row-major.
    ibm = np.transpose(ibm, (0, 2, 1)).astype(np.float64)

    world = world_matrices(gltf, sample_clip(gltf, binary, t))
    joint_matrices = np.stack([world[j] @ ibm[i] for i, j in enumerate(skin["joints"])])

    homogeneous = np.concatenate([positions, np.ones((len(positions), 1))], axis=1)
    out = np.zeros((len(positions), 3))
    for slot in range(joints.shape[1]):
        w = weights[:, slot]
        if not np.any(w):
            continue
        mats = joint_matrices[joints[:, slot]]
        out += w[:, None] * np.einsum("nij,nj->ni", mats, homogeneous)[:, :3]
    return out


def bones_at(gltf: dict, binary: bytes, t: float) -> list[tuple[np.ndarray, np.ndarray]]:
    """Parent->child segments of the skin's joints, posed at time t."""
    mesh_node = next(n for n in gltf["nodes"] if "mesh" in n and "skin" in n)
    joints = gltf["skins"][mesh_node["skin"]]["joints"]
    world = world_matrices(gltf, sample_clip(gltf, binary, t))
    parent_of: dict[int, int] = {}
    for index, node in enumerate(gltf["nodes"]):
        for child in node.get("children", []):
            parent_of[int(child)] = index
    out = []
    for j in joints:
        p = parent_of.get(j)
        if p is not None and p in world:
            out.append((world[p][:3, 3], world[j][:3, 3]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("--out", default="animated-strip.png")
    ap.add_argument("--frames", type=int, default=8)
    args = ap.parse_args()

    gltf, binary = read_glb(args.glb)
    anims = gltf.get("animations", [])
    if not anims:
        print("FAIL: no animation in this GLB")
        return 1
    times = np.asarray(accessor(gltf, binary, anims[0]["samplers"][0]["input"])).ravel()
    duration = float(times.max())
    print(f"clip {anims[0].get('name','?')!r}: {len(times)} keys, {duration:.2f}s")
    print(f"  {len(anims[0]['channels'])} channels over {len(gltf['nodes'])} nodes")

    picks = np.linspace(0, duration, args.frames)
    posed = [skin_at(gltf, binary, float(t)) for t in picks]

    # Did it actually MOVE? Compared against the first sampled pose, in the
    # body's own frame, so walking across the world does not disguise a mesh
    # that is rigidly translating without deforming.
    first = posed[0]
    moved = max(
        float(np.abs((p - p.mean(0)) - (first - first.mean(0))).max()) for p in posed[1:]
    )
    travel = max(float(np.linalg.norm(p.mean(0) - first.mean(0))) for p in posed[1:])
    print(f"  deformation vs first pose: {moved:.3f} m")
    print(f"  travel of the body centre: {travel:.3f} m")
    if moved < 1e-3:
        print("FAIL: the mesh does not deform — the clip is not driving the skin")
        return 1

    from PIL import Image, ImageDraw

    W = H = 240
    img = Image.new("RGB", (W * len(picks), H), (17, 17, 20))
    dr = ImageDraw.Draw(img)
    # Each frame is drawn CENTRED on its own body. Sharing one projection
    # across the clip is technically honest and visually useless: a character
    # that walks 5 m renders as eight specks. Travel is reported as a number
    # above; these panels are for reading the pose.
    body = max(
        max(float(p[:, 1].max() - p[:, 1].min()), float(p[:, 2].max() - p[:, 2].min()))
        for p in posed
    )
    span = body * 1.25
    for k, (t, verts) in enumerate(zip(picks, posed)):
        ox = k * W
        cz = 0.5 * (verts[:, 2].max() + verts[:, 2].min())
        cy = 0.5 * (verts[:, 1].max() + verts[:, 1].min())
        for _vx, vy, vz in verts[:: max(1, len(verts) // 4000)]:
            px = ox + W / 2 + (vz - cz) / span * (W - 30)
            py = H / 2 - (vy - cy) / span * (H - 30)
            dr.point((px, py), fill=(120, 128, 142))
        # The skeleton over the skin. A mesh made of disconnected parts (a
        # blocked-out character, a kitbash) renders as scattered dots whether
        # or not the rig is right, so the bones are what makes the pose
        # readable — and they come from the same FK the skinning used.
        for a, c in bones_at(gltf, binary, float(t)):
            dr.line(
                [
                    (ox + W / 2 + (a[2] - cz) / span * (W - 30), H / 2 - (a[1] - cy) / span * (H - 30)),
                    (ox + W / 2 + (c[2] - cz) / span * (W - 30), H / 2 - (c[1] - cy) / span * (H - 30)),
                ],
                fill=(235, 240, 250),
                width=2,
            )
        dr.text((ox + 8, 6), f"{t:.1f}s", fill=(140, 145, 155))
    img.save(args.out)
    print(f"wrote {args.out}")
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
