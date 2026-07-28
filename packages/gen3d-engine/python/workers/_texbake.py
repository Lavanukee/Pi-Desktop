"""Bake one mesh's appearance onto another mesh's own, new UV atlas.

WHY THIS EXISTS
---------------
Retopology throws the UVs away and it has no choice: QuadriFlow is handed a
positions-only OBJ (see export_geometry_obj) and rebuilds the surface from
scratch. MEASURED: every retopo.glb the studio has ever written is
`images=0 materials=0`, POSITION+NORMAL only. Everything downstream then
inherits a naked mesh — which is why RIGGING looked like the thing destroying
textures. It never was; it was handed a mesh that had already lost them.

WHY NOT JUST COPY THE UVs ACROSS
--------------------------------
That was the first attempt and it is not good enough here. Transferring the
source's UVs per vertex means a new triangle whose corners land on two different
atlas charts samples a stripe straight across the atlas. MEASURED on a TRELLIS
character: its atlas has 25,843 charts with a MEDIAN OF 4 VERTICES each, while
retopology is ~15x coarser — so most new triangles span more than one chart no
matter how carefully the corners are snapped. Forcing each triangle onto one
chart cut the smearing (77.5% -> 33.6% of triangles with a torn UV edge) but
could not remove it, because the information simply is not expressible in the
source's parametrisation.

So: give the new mesh its OWN atlas (xatlas), then fill that atlas by asking,
for every texel, what the source looks like at that point in space. That is a
texture bake, it is seam-free by construction, and it works for any pair of
meshes that occupy the same space — including an imported model with no colour
volume to re-derive from.
"""

from __future__ import annotations

from typing import Callable

import numpy as np
import trimesh

from _meshprep import base_colour


def _islands(mesh: trimesh.Trimesh) -> np.ndarray:
    """Per-VERTEX atlas-chart id of a render mesh.

    A GLB duplicates its vertices along every UV seam, so the face-connectivity
    graph is genuinely disconnected there — connected components ARE the charts,
    with no UV comparison needed.
    """
    faces = np.asarray(mesh.faces)
    try:
        face_label = trimesh.graph.connected_component_labels(
            mesh.face_adjacency, node_count=len(faces)
        )
    except Exception:  # noqa: BLE001 — one chart is a safe, correct fallback
        return np.zeros(len(mesh.vertices), dtype=np.int64)
    label = np.zeros(len(mesh.vertices), dtype=np.int64)
    label[faces.ravel()] = np.repeat(face_label, 3)
    return label


def rasterise(uv: np.ndarray, faces: np.ndarray, vertices: np.ndarray, size: int):
    """Atlas -> (position per texel, covered mask).

    Standard bounding-box barycentric fill, one triangle at a time. Sampling at
    texel CENTRES (+0.5) and admitting a hair of negative barycentric slack
    keeps chart edges from dropping a pixel row, which shows up as a dark seam
    once the GPU filters across it.
    """
    pos = np.zeros((size, size, 3), dtype=np.float32)
    mask = np.zeros((size, size), dtype=bool)

    px = np.stack([uv[:, 0] * (size - 1), (1.0 - uv[:, 1]) * (size - 1)], axis=1)
    tri_px = px[faces]  # (F, 3, 2)
    tri_xyz = vertices[faces]  # (F, 3, 3)

    lo = np.floor(tri_px.min(axis=1)).astype(np.int64)
    hi = np.ceil(tri_px.max(axis=1)).astype(np.int64)
    np.clip(lo, 0, size - 1, out=lo)
    np.clip(hi, 0, size - 1, out=hi)

    for f in range(len(faces)):
        x0, y0 = lo[f]
        x1, y1 = hi[f]
        if x1 < x0 or y1 < y0:
            continue
        a, b, c = tri_px[f]
        area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
        if abs(area) < 1e-12:
            continue
        ys, xs = np.mgrid[y0 : y1 + 1, x0 : x1 + 1]
        qx = xs + 0.5
        qy = ys + 0.5
        w0 = ((b[0] - qx) * (c[1] - qy) - (c[0] - qx) * (b[1] - qy)) / area
        w1 = ((c[0] - qx) * (a[1] - qy) - (a[0] - qx) * (c[1] - qy)) / area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -0.002) & (w1 >= -0.002) & (w2 >= -0.002)
        if not inside.any():
            continue
        p, q, r = tri_xyz[f]
        hit = np.stack([w0[inside], w1[inside], w2[inside]], axis=1)
        pos[ys[inside], xs[inside]] = hit @ np.stack([p, q, r])
        mask[ys[inside], xs[inside]] = True
    return pos, mask


def sample_source(
    source: trimesh.Trimesh,
    uv_src: np.ndarray,
    image,
    points: np.ndarray,
    *,
    neighbours: int = 4,
) -> np.ndarray:
    """Colour of the source surface at each 3D point, as uint8 RGB.

    Nearest source vertex gives the atlas coordinate to read. Blending the k
    nearest by inverse distance would quantise less, but ONLY among vertices of
    the same chart — averaging UVs across a seam lands in the middle of the
    atlas, on some unrelated part of the model. So neighbours from other charts
    are dropped rather than blended.
    """
    from scipy.spatial import cKDTree

    tree = cKDTree(np.asarray(source.vertices, dtype=np.float64))
    k = min(neighbours, len(source.vertices))
    dist, idx = tree.query(points, k=k, workers=-1)
    if k == 1:
        dist, idx = dist[:, None], idx[:, None]

    chart = _islands(source)
    same = chart[idx] == chart[idx[:, :1]]
    weight = np.where(same, 1.0 / np.maximum(dist, 1e-9), 0.0)
    uv = (uv_src[idx] * weight[:, :, None]).sum(axis=1) / weight.sum(axis=1)[:, None]

    px = np.asarray(image.convert("RGB"))
    h, w = px.shape[:2]
    u = np.clip((uv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(np.int64)
    v = np.clip((1.0 - (uv[:, 1] % 1.0)) * (h - 1), 0, h - 1).astype(np.int64)
    return px[v, u]


def bake(
    source: trimesh.Trimesh,
    target: trimesh.Trimesh,
    log: Callable[[str], None] | None = None,
    *,
    size: int = 2048,
) -> trimesh.Trimesh | None:
    """`target`, unwrapped and painted to look like `source`. None if it cannot.

    Returns a mesh whose vertices may outnumber the input's: xatlas splits
    vertices along the seams of the atlas it invents, which is what makes the
    atlas possible in the first place.
    """
    say = log or (lambda _m: None)
    uv_src, image = base_colour(source)
    if uv_src is None:
        return None
    try:
        import xatlas
    except ImportError:
        say("xatlas is not installed — the new topology cannot be given a texture")
        return None
    from PIL import Image
    from scipy import ndimage

    say(f"Unwrapping {len(target.faces):,} faces for a fresh {size}×{size} atlas…")
    vmap, faces, uv = xatlas.parametrize(
        np.asarray(target.vertices, dtype=np.float32),
        np.asarray(target.faces, dtype=np.uint32),
    )
    vertices = np.asarray(target.vertices, dtype=np.float64)[vmap]
    faces = np.asarray(faces, dtype=np.int64)
    uv = np.asarray(uv, dtype=np.float64)

    pos, mask = rasterise(uv, faces, vertices, size)
    covered = int(mask.sum())
    if covered == 0:
        say("the unwrap produced an empty atlas")
        return None
    say(f"Baking {covered:,} texels from the original surface…")

    rgb = np.zeros((size, size, 3), dtype=np.uint8)
    rgb[mask] = sample_source(source, uv_src, image, pos[mask])

    # Flood the gaps between charts outward from the nearest baked texel. A
    # bilinear fetch near a chart edge reaches past it, and unpainted black
    # there reads as a dark crack along every seam.
    _dist, nearest = ndimage.distance_transform_edt(~mask, return_indices=True)
    rgb = rgb[nearest[0], nearest[1]]

    painted = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    painted.visual = trimesh.visual.TextureVisuals(
        uv=uv,
        material=trimesh.visual.material.PBRMaterial(
            name="baked",
            baseColorTexture=Image.fromarray(rgb),
            metallicFactor=0.0,
            roughnessFactor=0.85,
        ),
    )
    # Which original vertex each new one came from. The caller needs it to keep
    # index-based side data (the quad wireframe) pointing at the right places.
    painted.metadata["pd_vertex_map"] = np.asarray(vmap, dtype=np.int64)
    say(f"Texture baked — {100 * covered / (size * size):.0f}% atlas coverage")
    return painted
