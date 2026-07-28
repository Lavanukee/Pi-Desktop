"""Derive a skeleton from a mesh's own medial axis — no template, no network.

WHY THIS EXISTS
---------------
The studio had exactly two riggers and neither suits an arbitrary shape. The
geometric one fits a FIXED 27-joint humanoid template, which is right for a
person and nonsense for a horse. SkinTokens will rig anything but it is a 2.5 GB
learned model the user has to download first. jedd: "can you have an option to
do medial axis rigging as a first choice before we ask the user to try
skintokens?"

So: read the skeleton off the shape itself. A curve skeleton derived from the
interior is what an artist would draw down the middle of each limb, it costs no
download and about a second, and it has no opinion about how many legs the
subject has.

HOW
---
Voxelise the interior, then walk it as a graph:

1. `distance_transform_edt` over the filled volume gives every interior voxel its
   distance to the surface. That field's ridge IS the medial axis, and it is also
   the local thickness — used later for both joint placement and skin falloff.
2. Geodesic distance from one extremity, found by the usual double sweep (walk to
   the farthest voxel, then walk again from there — that endpoint is on the
   shape's longest path).
3. Slice the interior into level sets of that geodesic distance. Each connected
   component of a slice is one cross-section of one limb; its thickness-weighted
   centroid sits on the medial axis. Where a body splits into two legs, the slice
   splits into two components — the branching comes out of the data rather than
   being asserted.
4. Join each component to the one it touches in the previous slice: a tree.
5. Re-root at the thickest joint (the torso, not the toe the sweep happened to
   start from), prune stub branches, and collapse the run-on chains that fine
   slicing produces into bones of a usable length.

Skinning is inverse-distance to the nearest bone SEGMENTS with a sharp falloff,
which keeps a limb's vertices on that limb's bone even where two limbs touch.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
import trimesh


@dataclass
class Skeleton:
    """A derived rig: joint positions, who each joint hangs off, thickness."""

    names: list[str]
    parent: dict[str, str | None]
    position: dict[str, np.ndarray]
    radius: dict[str, float]

    @property
    def root(self) -> str:
        return next(n for n in self.names if self.parent[n] is None)

    def bones(self) -> list[tuple[str, str]]:
        return [(self.parent[n], n) for n in self.names if self.parent[n] is not None]

    def as_dict(self) -> dict:
        return {
            "skeleton": "medial-axis",
            "bones": [
                {
                    "name": n,
                    "parent": self.parent[n],
                    "head": [float(v) for v in self.position[n]],
                    "radius": round(float(self.radius[n]), 5),
                }
                for n in self.names
            ],
        }


def _voxelise(mesh: trimesh.Trimesh, grid: int, max_faces: int = 80_000):
    """Filled interior as a boolean array, plus the index->world transform.

    Voxelisation is the whole cost of this module — everything after it runs in
    tenths of a second — and it scales with triangle count, so a dense mesh is
    thinned first. Nothing is lost: the grid quantises to `extent/grid` anyway,
    which is far coarser than the tessellation of a generated model.
    """
    extent = float(max(mesh.extents))
    if extent <= 0:
        raise ValueError("this mesh has no size")
    if len(mesh.faces) > max_faces:
        try:
            mesh = mesh.simplify_quadric_decimation(face_count=max_faces)
        except Exception:  # noqa: BLE001 — slower is fine, wrong is not
            pass
    pitch = extent / float(grid)
    vox = mesh.voxelized(pitch=pitch)
    # ORTHOGRAPHIC, not the default. trimesh fills with 'holes' by default —
    # binary_fill_holes, which only closes cavities that are fully enclosed. A
    # generated mesh is not: MEASURED on a TRELLIS character, 973 open edges and
    # 195 non-manifold ones are enough for the fill to leak straight out, and the
    # "interior" came back as 24,222 cells against a 24,144-cell shell. The rig
    # was then the medial axis OF A SHELL: limb centres roughly right, every
    # thickness meaningless, and the root landing on a hand. Orthographic scans
    # each axis instead and gives 64,783 cells on the same mesh.
    for method in ("orthographic", "base", "holes"):
        try:
            filled = vox.copy().fill(method=method)
        except Exception:  # noqa: BLE001 — try the next strategy
            continue
        matrix = np.asarray(filled.matrix, dtype=bool)
        if matrix.sum() > 0:
            return matrix, filled.transform, pitch
    return np.asarray(vox.matrix, dtype=bool), vox.transform, pitch


def _neighbour_edges(occupied: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """26-connected edges between occupied voxels, as (from, to, length).

    Built by shifting the whole array rather than looping over voxels — the
    interior of a character at 128³ is a few hundred thousand voxels and a
    Python loop over their neighbourhoods is minutes, not milliseconds.
    """
    index = np.full(occupied.shape, -1, dtype=np.int64)
    index[occupied] = np.arange(int(occupied.sum()))
    froms: list[np.ndarray] = []
    tos: list[np.ndarray] = []
    lengths: list[np.ndarray] = []
    # Half the 26 offsets: the graph is undirected, so the mirrored half is
    # implied and adding it would only double the memory.
    for dx in (0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                if dx == 0 and (dy < 0 or (dy == 0 and dz <= 0)):
                    continue
                a = index[
                    max(0, -dx) : occupied.shape[0] - max(0, dx),
                    max(0, -dy) : occupied.shape[1] - max(0, dy),
                    max(0, -dz) : occupied.shape[2] - max(0, dz),
                ]
                b = index[
                    max(0, dx) : occupied.shape[0] + min(0, dx) or None,
                    max(0, dy) : occupied.shape[1] + min(0, dy) or None,
                    max(0, dz) : occupied.shape[2] + min(0, dz) or None,
                ]
                both = (a >= 0) & (b >= 0)
                if not both.any():
                    continue
                froms.append(a[both])
                tos.append(b[both])
                lengths.append(
                    np.full(int(both.sum()), float(np.sqrt(dx * dx + dy * dy + dz * dz)))
                )
    if not froms:
        return np.empty(0, np.int64), np.empty(0, np.int64), np.empty(0, float)
    return np.concatenate(froms), np.concatenate(tos), np.concatenate(lengths)


def _bridge_components(
    points: np.ndarray,
    fr: np.ndarray,
    to: np.ndarray,
    length: np.ndarray,
    count: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Join detached interior pieces to the main one at their closest points.

    The studio's own meshes routinely come apart in here: a kitbashed or
    segmented model is several solids, and a limb that meets the body across one
    voxel of overlap is a separate component at a coarser pitch. Dropping those
    pieces loses the limb entirely and says nothing about it — MEASURED on a test
    quadruped, 9,296 of 73,106 cells fell off and the rig came back as a spine
    with no legs. A shortest bridge is the honest reading: those parts do touch
    in the shape the user sees.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree

    parts, label = connected_components(
        coo_matrix((np.ones(len(fr)), (fr, to)), shape=(count, count)), directed=False
    )
    if parts <= 1:
        return fr, to, length, 0
    sizes = np.bincount(label, minlength=parts)
    main = int(np.argmax(sizes))
    main_cells = np.flatnonzero(label == main)
    tree = cKDTree(points[main_cells])
    add_from, add_to, add_len = [], [], []
    for part in range(parts):
        if part == main:
            continue
        cells = np.flatnonzero(label == part)
        distance, nearest = tree.query(points[cells], k=1)
        pick = int(np.argmin(distance))
        add_from.append(cells[pick])
        add_to.append(main_cells[nearest[pick]])
        add_len.append(float(distance[pick]))
    return (
        np.concatenate([fr, np.asarray(add_from, dtype=np.int64)]),
        np.concatenate([to, np.asarray(add_to, dtype=np.int64)]),
        np.concatenate([length, np.asarray(add_len, dtype=float)]),
        parts - 1,
    )


def _geodesic(graph, source: int) -> np.ndarray:
    from scipy.sparse.csgraph import dijkstra

    return dijkstra(graph, directed=False, indices=source)


def extract(
    mesh: trimesh.Trimesh,
    log: Callable[[str], None] | None = None,
    *,
    grid: int = 110,
    slices: float = 2.5,
    min_branch: float = 0.06,
    bone_length: float = 0.08,
) -> Skeleton:
    """The mesh's curve skeleton. `min_branch`/`bone_length` are fractions of the
    model's longest dimension."""
    say = log or (lambda _m: None)
    from scipy import ndimage
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    occupied, transform, pitch = _voxelise(mesh, grid)
    count = int(occupied.sum())
    if count < 8:
        raise ValueError("this mesh is too thin to find an interior in")
    say(f"Filled the interior — {count:,} cells at {pitch * 1000:.1f} mm")

    # Distance to the surface, in voxels. Padding keeps a shape that touches the
    # grid edge from reading as infinitely thick there.
    padded = np.pad(occupied, 1)
    thickness = ndimage.distance_transform_edt(padded)[1:-1, 1:-1, 1:-1][occupied]

    coords = np.argwhere(occupied).astype(np.float64)
    points = trimesh.transform_points(coords + 0.5, transform)

    fr, to, length = _neighbour_edges(occupied)
    fr, to, length, bridged = _bridge_components(points, fr, to, length, count)
    if bridged:
        say(f"Bridged {bridged} detached part(s) to the body")
    graph = coo_matrix((length, (fr, to)), shape=(count, count)).tocsr()

    # Double sweep: an arbitrary start reaches SOME extremity; walking again from
    # there reaches the other end of the shape's longest path.
    first = _geodesic(graph, int(np.argmax(points[:, 1])))
    first[~np.isfinite(first)] = -1
    far = int(np.argmax(first))
    geo = _geodesic(graph, far)
    reachable = np.isfinite(geo)
    if reachable.sum() < count:
        say(f"{count - int(reachable.sum()):,} cells are cut off and were left out")

    # ── slice the interior into level sets of geodesic distance ──────────────
    step = slices
    band = np.full(count, -1, dtype=np.int64)
    band[reachable] = (geo[reachable] / step).astype(np.int64)

    # Group cells and intra-band edges by band ONCE. Scanning the full edge list
    # per band instead cost 62s on a 161k-cell model — with ~100 bands that is a
    # hundred passes over two million edges, and a hundred count x count sparse
    # matrices built only to be sliced down to a few thousand rows.
    cell_order = np.argsort(band, kind="stable")
    cell_start = np.searchsorted(band[cell_order], np.arange(int(band.max()) + 2))
    inside_band = (band[fr] >= 0) & (band[fr] == band[to])
    edge_band = band[fr][inside_band]
    edge_a, edge_b = fr[inside_band], to[inside_band]
    edge_order = np.argsort(edge_band, kind="stable")
    edge_band, edge_a, edge_b = (
        edge_band[edge_order],
        edge_a[edge_order],
        edge_b[edge_order],
    )
    edge_start = np.searchsorted(edge_band, np.arange(int(band.max()) + 2))
    local = np.empty(count, dtype=np.int64)

    nodes: list[np.ndarray] = []
    node_radius: list[float] = []
    node_cells: list[np.ndarray] = []
    cell_node = np.full(count, -1, dtype=np.int64)
    for level in range(int(band.max()) + 1):
        members = cell_order[cell_start[level] : cell_start[level + 1]]
        if len(members) == 0:
            continue
        local[members] = np.arange(len(members))
        lo, hi = edge_start[level], edge_start[level + 1]
        sub = coo_matrix(
            (np.ones(hi - lo), (local[edge_a[lo:hi]], local[edge_b[lo:hi]])),
            shape=(len(members), len(members)),
        )
        parts, labels = connected_components(sub, directed=False)
        for part in range(parts):
            cells = members[labels == part]
            # A slice component of one or two voxels is grid noise, not a limb.
            if len(cells) < 3:
                continue
            # Weighted by thickness so the joint lands on the medial axis rather
            # than at the centre of area — they differ wherever a cross-section
            # is not symmetric, which is most places on a real character.
            w = thickness[cells] ** 2
            nodes.append((points[cells] * w[:, None]).sum(0) / w.sum())
            node_radius.append(float(thickness[cells].max() * pitch))
            node_cells.append(cells)
            cell_node[cells] = len(nodes) - 1
    if len(nodes) < 2:
        raise ValueError("this mesh has no length to run a skeleton along")
    say(f"Traced {len(nodes)} cross-sections along the shape")

    # ── join each node to the node it touches one slice back ─────────────────
    na, nb = cell_node[fr], cell_node[to]
    linked = (na >= 0) & (nb >= 0) & (na != nb)
    lo_node = np.minimum(na[linked], nb[linked])
    hi_node = np.maximum(na[linked], nb[linked])
    touching, contact = np.unique(
        np.stack([lo_node, hi_node], axis=1), axis=0, return_counts=True
    )

    # Each node hangs off whichever earlier node it shares the most surface with.
    # "Earlier" is by geodesic distance, so the tree grows outward from the sweep
    # start and every branch runs the way the shape does.
    depth = np.array([float(geo[cells].min()) for cells in node_cells])
    parent = np.full(len(nodes), -1, dtype=np.int64)
    best = np.zeros(len(nodes), dtype=np.int64)
    for (a, b), count_ab in zip(touching, contact):
        child, up = (int(b), int(a)) if depth[a] < depth[b] else (int(a), int(b))
        if depth[up] >= depth[child] or count_ab <= best[child]:
            continue
        best[child], parent[child] = int(count_ab), up

    skeleton = _to_tree(np.asarray(nodes), np.asarray(node_radius), parent)
    extent = float(max(mesh.extents))
    skeleton = _prune(skeleton, min_branch * extent)
    skeleton = _reroot_at_body(skeleton)
    skeleton = _collapse_chains(skeleton, bone_length * extent)
    say(f"Skeleton: {len(skeleton.names)} joints, {len(skeleton.bones())} bones")
    return skeleton


# ── tree shaping ────────────────────────────────────────────────────────────
def _to_tree(positions: np.ndarray, radii: np.ndarray, parent: np.ndarray) -> Skeleton:
    """Index arrays -> a named Skeleton, keeping only the root's own component."""
    roots = np.flatnonzero(parent < 0)
    # More than one root means the interior came apart; keep the biggest tree.
    children: dict[int, list[int]] = {}
    for i, p in enumerate(parent):
        if p >= 0:
            children.setdefault(int(p), []).append(i)

    def size(node: int) -> int:
        total, stack = 0, [node]
        while stack:
            here = stack.pop()
            total += 1
            stack.extend(children.get(here, []))
        return total

    root = int(max(roots, key=size)) if len(roots) > 0 else 0
    keep, stack = [], [root]
    while stack:
        here = stack.pop()
        keep.append(here)
        stack.extend(children.get(here, []))

    name_of = {i: f"joint_{k:02d}" for k, i in enumerate(keep)}
    return Skeleton(
        names=[name_of[i] for i in keep],
        parent={
            name_of[i]: (name_of[int(parent[i])] if int(parent[i]) in name_of else None)
            for i in keep
        },
        position={name_of[i]: positions[i] for i in keep},
        radius={name_of[i]: float(radii[i]) for i in keep},
    )


def _children(skeleton: Skeleton) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {n: [] for n in skeleton.names}
    for n in skeleton.names:
        p = skeleton.parent[n]
        if p is not None:
            out[p].append(n)
    return out


def _prune(skeleton: Skeleton, min_length: float) -> Skeleton:
    """Drop branches shorter than `min_length`.

    Fine slicing finds every bump: an ear, a thumb, a lump of noise on a shoulder
    each become a two-joint stub. They are real features of the medial axis and
    useless as bones, and each one costs an influence slot in the skin.
    """
    kids = _children(skeleton)
    doomed: set[str] = set()
    for name in reversed(skeleton.names):  # leaves first
        if name in doomed or skeleton.parent[name] is None:
            continue
        if any(c not in doomed for c in kids[name]):
            continue  # still has a living branch below it — not a stub end
        # Walk back to the nearest LIVING branch point and measure the whole
        # stub. The test has to exclude the child we arrived from: counting it
        # meant a node whose other stubs had already been pruned looked like a
        # plain link in a chain, so the walk absorbed it and orphaned the live
        # limb hanging off it — which crashed on a real generated mesh with a
        # parent that no longer existed.
        chain, here = [name], name
        while True:
            up = skeleton.parent[here]
            if up is None or any(c not in doomed and c != here for c in kids[up]):
                break
            chain.append(up)
            here = up
        if skeleton.parent[chain[-1]] is None:
            continue  # this is the trunk itself, not something hanging off it
        span = float(
            np.linalg.norm(skeleton.position[chain[0]] - skeleton.position[chain[-1]])
        )
        if span < min_length:
            doomed.update(chain)
    if not doomed:
        return skeleton
    names = [n for n in skeleton.names if n not in doomed]
    return Skeleton(
        names=names,
        parent={n: skeleton.parent[n] for n in names},
        position={n: skeleton.position[n] for n in names},
        radius={n: skeleton.radius[n] for n in names},
    )


def _reroot_at_body(skeleton: Skeleton) -> Skeleton:
    """Hang the tree off the body instead of wherever the sweep began.

    The sweep starts at an EXTREMITY by construction — a fingertip, a toe, an
    antenna — and a rig rooted there has every bone pointing the wrong way and
    animates from the wrong end.

    "The body" is the tree's CENTRE: the joint whose farthest leaf is nearest,
    tie-broken by thickness. Thickness alone is the more obvious choice and it is
    not reliable — it depends on the interior being solid, and on a mesh where
    the fill leaks it put the root on a hand. Eccentricity depends only on the
    skeleton's own shape, and it lands on the pelvis of a character, the middle
    of a quadruped's back, and the centre of a starfish.
    """
    adjacency: dict[str, set[str]] = {n: set() for n in skeleton.names}
    for n in skeleton.names:
        p = skeleton.parent[n]
        if p is not None:
            adjacency[n].add(p)
            adjacency[p].add(n)

    def eccentricity(start: str) -> float:
        seen = {start: 0.0}
        stack = [start]
        while stack:
            here = stack.pop()
            for other in adjacency[here]:
                if other in seen:
                    continue
                seen[other] = seen[here] + float(
                    np.linalg.norm(skeleton.position[other] - skeleton.position[here])
                )
                stack.append(other)
        return max(seen.values())

    target = min(skeleton.names, key=lambda n: (eccentricity(n), -skeleton.radius[n]))
    if skeleton.parent[target] is None:
        return skeleton
    parent: dict[str, str | None] = {target: None}
    order, stack = [target], [target]
    while stack:
        here = stack.pop()
        for other in adjacency[here]:
            if other in parent:
                continue
            parent[other] = here
            order.append(other)
            stack.append(other)
    return Skeleton(
        names=order,
        parent=parent,
        position=skeleton.position,
        radius=skeleton.radius,
    )


def _collapse_chains(skeleton: Skeleton, target_length: float) -> Skeleton:
    """Keep branch points, leaves, and a joint every `target_length` between.

    A 2.5-voxel slice pitch puts a joint every few millimetres; a limb becomes 40
    collinear joints that no one can pose and that bloat every skin weight. The
    shape of the skeleton lives in its branch points — the rest is resampling.
    """
    kids = _children(skeleton)
    root = skeleton.root
    keep = {root}
    for name in skeleton.names:
        if len(kids[name]) != 1:  # branch point or leaf
            keep.add(name)
    # Then walk each chain and drop a joint in whenever it has run far enough.
    for name in skeleton.names:
        if name in keep:
            continue
        anchor, here = None, name
        while anchor is None:
            up = skeleton.parent[here]
            if up is None:
                break
            if up in keep:
                anchor = up
            here = up
        if anchor is None:
            continue
        if float(np.linalg.norm(skeleton.position[name] - skeleton.position[anchor])) >= (
            target_length
        ):
            keep.add(name)

    def surviving_parent(name: str) -> str | None:
        up = skeleton.parent[name]
        while up is not None and up not in keep:
            up = skeleton.parent[up]
        return up

    names = [n for n in skeleton.names if n in keep]
    rename = {n: f"joint_{i:02d}" for i, n in enumerate(names)}
    return Skeleton(
        names=[rename[n] for n in names],
        parent={
            rename[n]: (None if surviving_parent(n) is None else rename[surviving_parent(n)])
            for n in names
        },
        position={rename[n]: skeleton.position[n] for n in names},
        radius={rename[n]: skeleton.radius[n] for n in names},
    )


# ── skinning ────────────────────────────────────────────────────────────────
def _segment_distance(points: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Distance from each point to the segment a-b."""
    ab = b - a
    denominator = float(ab @ ab)
    if denominator < 1e-12:
        return np.linalg.norm(points - a, axis=1)
    t = np.clip(((points - a) @ ab) / denominator, 0.0, 1.0)
    return np.linalg.norm(points - (a + t[:, None] * ab), axis=1)


def skin(
    vertices: np.ndarray,
    skeleton: Skeleton,
    *,
    influences: int = 4,
    falloff: float = 4.0,
) -> tuple[np.ndarray, np.ndarray]:
    """(joint index, joint weight) per vertex, glTF-shaped (N, 4).

    Weighted by 1/distance-to-BONE, not to joint: a point halfway down a thigh
    belongs to the thigh, and measuring to joint centres would hand it to
    whichever joint happens to be nearer along the way. The falloff is steep on
    purpose — where two limbs touch, a gentle one bleeds each limb's surface onto
    the other's bone and the two move together.
    """
    bones = skeleton.bones()
    names = skeleton.names
    slot = {n: i for i, n in enumerate(names)}
    if not bones:
        index = np.zeros((len(vertices), 4), dtype=np.uint16)
        weight = np.zeros((len(vertices), 4), dtype=np.float32)
        weight[:, 0] = 1.0
        return index, weight

    distance = np.stack(
        [
            _segment_distance(vertices, skeleton.position[p], skeleton.position[c])
            for p, c in bones
        ],
        axis=1,
    )
    k = min(influences, distance.shape[1])
    nearest = np.argpartition(distance, k - 1, axis=1)[:, :k]
    picked = np.take_along_axis(distance, nearest, axis=1)

    # Only bones comparably close to the nearest get a say. Without this cut a
    # vertex on one thigh keeps a real weight on the other thigh's bone, and the
    # legs drag each other around.
    closest = picked.min(axis=1, keepdims=True)
    admissible = picked <= np.maximum(closest * 1.8, closest + 1e-9)
    w = np.where(admissible, 1.0 / np.maximum(picked, 1e-6) ** falloff, 0.0)
    total = w.sum(axis=1, keepdims=True)
    w = np.where(total > 0, w / np.maximum(total, 1e-30), 0.0)
    w[total[:, 0] <= 0, 0] = 1.0

    # A bone's weight belongs to its CHILD joint: that is the joint whose
    # rotation moves the bone, and it is what glTF's joint list indexes.
    child_of_bone = np.asarray([slot[c] for _p, c in bones], dtype=np.uint16)
    index = np.zeros((len(vertices), 4), dtype=np.uint16)
    weight = np.zeros((len(vertices), 4), dtype=np.float32)
    index[:, :k] = child_of_bone[nearest]
    weight[:, :k] = w
    return index, weight
