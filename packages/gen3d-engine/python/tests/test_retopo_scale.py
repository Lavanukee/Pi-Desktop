"""Retopology must hand back a mesh in the coordinates it was given.

THE BUG: `make_manifold()` repairs an unremeshable surface by voxelising and
re-extracting with marching cubes. trimesh's `VoxelGrid.marching_cubes` returns
vertices in GRID INDEX space (0..grid per axis), not world space, and the grid
transform was never applied. With the default 384 grid a model measuring
0.479 x 0.478 x 1.0 about the origin came back as 185 x 188 x 388 centred on
(92, 94, 175) — 384x too large and parked in the positive octant.

Two things hid it:
  the viewer frames whatever it is handed, so a lone broken result looks
  plausible until you compare it with anything;
  make_manifold only runs when the input NEEDS repair. A clean mesh skips it
  and keeps its scale. That is why retopology looked correct on one mesh and
  destroyed another — nothing to do with the remesher, everything to do with
  whether this path ran. A UV-unwrapped textured export always triggers it:
  xatlas splits vertices along every atlas seam, so the GLB reads as ~20,000
  disconnected islands (measured: 273,034 boundary edges on a 300k-face model
  against 5 components and 102,624 on the untextured mesh from the same run).

The assertion is on the BOUNDING BOX, not the vertices: voxel repair is
deliberately lossy at the grid pitch, so the shape may move slightly. What it
must never do is change the units.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import numpy as np

WORKERS = Path(__file__).resolve().parents[1] / "workers"


def _retopo_module():
    """Import retopo_worker without running its CLI."""
    sys.path.insert(0, str(WORKERS))
    spec = importlib.util.spec_from_file_location("retopo_worker", WORKERS / "retopo_worker.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_make_manifold_preserves_world_scale() -> None:
    try:
        import trimesh
    except ModuleNotFoundError as err:  # not the system interpreter's job
        from _skip import Skip

        raise Skip("needs trimesh — run from the meshtools or cube venv") from err

    # A shape with the proportions of a real generation (tall, off-square) and
    # a deliberately non-unit size, so an index-space result cannot coincide.
    mesh = trimesh.creation.box(extents=(0.479, 0.478, 1.0))
    before_extents = mesh.extents.copy()
    before_centroid = mesh.centroid.copy()

    healed = _retopo_module().make_manifold(mesh, 64, lambda _m: None)

    # 20% tolerance: marching cubes at a coarse grid rounds corners. A missing
    # transform is off by the grid factor (64x here), nowhere near this band.
    assert np.allclose(healed.extents, before_extents, rtol=0.2), (
        f"extents changed: {before_extents} -> {healed.extents}"
    )
    # And it must stay where it was, not move to the positive octant.
    assert np.allclose(healed.centroid, before_centroid, atol=0.1), (
        f"centroid moved: {before_centroid} -> {healed.centroid}"
    )
