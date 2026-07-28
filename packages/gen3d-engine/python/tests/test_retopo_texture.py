"""Retopology must not throw the model's appearance away — and must not lie
about having succeeded when the remesher hands back garbage.

TWO REAL FAILURES, both MEASURED on this machine, both silent:

1. Every retopo.glb the studio had ever written was `images=0 materials=0`,
   POSITION+NORMAL only. QuadriFlow is handed a positions-only OBJ and rebuilds
   the surface, so UVs cannot survive — and the rig stage, which carries a
   texture through perfectly well on its own, then LOOKED like the thing
   destroying textures because it was handed a mesh that had already lost them.

2. On a TRELLIS character rebuilt through the 384³ voxel path, QuadriFlow ran to
   completion, exited 0, and wrote an 18,649-vertex OBJ in which every single
   vertex was `nan nan nan`. Nothing downstream noticed: the polygon count was
   healthy and the studio reported a successful retopology of an invisible model
   with a NaN bounding box.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import numpy as np

WORKERS = Path(__file__).resolve().parents[1] / "workers"


def _retopo_module():
    sys.path.insert(0, str(WORKERS))
    spec = importlib.util.spec_from_file_location("retopo_worker", WORKERS / "retopo_worker.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _needs(*modules: str):
    for name in modules:
        try:
            __import__(name)
        except ModuleNotFoundError as err:
            from _skip import Skip

            raise Skip(f"needs {name} — run from the meshtools venv") from err


def _ok(code: int = 0):
    return subprocess.CompletedProcess([], code, "", "")


def test_all_nan_output_is_not_a_successful_remesh(tmp_path: Path = Path("/tmp")) -> None:
    _needs("trimesh")
    mod = _retopo_module()
    obj = Path(tmp_path) / "nan-quads.obj"

    obj.write_text("v nan nan nan\nv nan nan nan\nv nan nan nan\nf 1 2 3\n")
    assert not mod.remesh_usable(_ok(), obj), "an all-NaN mesh must not count as remeshed"

    obj.write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")
    assert mod.remesh_usable(_ok(), obj), "a finite mesh must count as remeshed"

    # One bad vertex among good ones is still poison: it makes the bounding box
    # NaN, which every downstream stage inherits.
    obj.write_text("v 0 0 0\nv 1 0 0\nv nan 1 0\nf 1 2 3\n")
    assert not mod.remesh_usable(_ok(), obj)

    obj.write_text("")
    assert not mod.remesh_usable(_ok(), obj), "an empty mesh must not count as remeshed"
    assert not mod.remesh_usable(_ok(1), obj)
    assert not mod.remesh_usable(None, obj)


def test_wireframe_indices_follow_the_bake(tmp_path: Path = Path("/tmp")) -> None:
    """Baking renumbers vertices; the quad wireframe has to come with them."""
    # trimesh too: importing retopo_worker pulls in _meshprep, which imports it
    # at module scope — so this skips on the system interpreter like its siblings
    # rather than failing there.
    _needs("numpy", "trimesh")
    mod = _retopo_module()

    # xatlas hands back vertex_map[new] = old. Here old vertex 1 was split in
    # two, and old vertex 3 was dropped by the unwrap entirely.
    vertex_map = [0, 1, 1, 2]
    mapped = mod.remap_wire([0, 1, 2, 3], vertex_map, 4)
    assert mapped[:2] == [0, 1] or mapped[:2] == [0, 2], mapped
    # The edge touching the dropped vertex is dropped rather than drawn to 0.
    assert len(mapped) == 2, mapped
    # No map (nothing was baked) leaves the wireframe exactly as it was.
    assert mod.remap_wire([0, 1, 2, 3], None, 4) == [0, 1, 2, 3]


def test_bake_puts_the_source_colours_on_new_topology() -> None:
    """A coarse remesh, baked, must look like the fine original in 3D."""
    _needs("trimesh", "xatlas", "scipy", "PIL")
    import trimesh
    from PIL import Image

    sys.path.insert(0, str(WORKERS))
    from _texbake import bake

    # Source: a dense sphere with a two-tone atlas — left half red, right half
    # blue — so a bake that is mirrored, rotated or offset cannot pass.
    source = trimesh.creation.icosphere(subdivisions=5, radius=1.0)
    direction = np.asarray(source.vertices)[:, 0] > 0
    uv = np.zeros((len(source.vertices), 2))
    uv[:, 0] = np.where(direction, 0.75, 0.25)
    uv[:, 1] = 0.5
    atlas = Image.new("RGB", (64, 64), (220, 30, 30))
    atlas.paste(Image.new("RGB", (32, 64), (30, 30, 220)), (32, 0))
    source.visual = trimesh.visual.TextureVisuals(
        uv=uv, material=trimesh.visual.material.PBRMaterial(baseColorTexture=atlas)
    )

    target = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
    painted = bake(source, target, size=256)
    assert painted is not None, "bake refused a textured source"

    baked = np.asarray(painted.visual.material.baseColorTexture.convert("RGB"))
    puv = np.asarray(painted.visual.uv)
    assert len(puv) == len(painted.vertices)
    assert np.isfinite(puv).all()

    # Read the baked atlas back at each vertex's own UV and check the colour
    # against the side of the sphere that vertex is on.
    h, w = baked.shape[:2]
    px = np.clip((puv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(int)
    py = np.clip((1.0 - (puv[:, 1] % 1.0)) * (h - 1), 0, h - 1).astype(int)
    colour = baked[py, px]
    verts = np.asarray(painted.vertices)
    # Ignore a band around the seam: a texel there legitimately straddles both.
    away = np.abs(verts[:, 0]) > 0.15
    reddish = colour[:, 0] > colour[:, 2]
    correct = reddish[away] == (verts[away, 0] < 0)
    assert correct.mean() > 0.97, f"only {correct.mean():.1%} of baked vertices got the right side"
