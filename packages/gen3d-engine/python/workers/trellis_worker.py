"""TRELLIS.2 worker — image → 3D geometry (+ native PBR texture) on MPS.

Runs inside the trellis-mac venv with cwd = the trellis-mac checkout (jobs.py
guarantees both). The generation/bake flow is adapted from trellis-mac's
generate.py (MIT); the differences are the NDJSON progress protocol, the
geometry-FIRST artifact push (untextured GLB the moment vertices exist, while
texturing continues), and `--no-texture` collapsing the tex-SLAT sampling to a
single step (upstream run() has no skip flag; one step costs ~nothing and the
result is discarded).

Stage identities on stdout: 'geometry' until the untextured GLB is emitted,
then 'texture' for tex sampling + baking.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import NamedTuple

# --- backend env BEFORE torch/trellis imports (mirrors trellis-mac) ---------
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("ATTN_BACKEND", "sdpa")
os.environ.setdefault("SPARSE_ATTN_BACKEND", "sdpa")

TRELLIS_ROOT = Path.cwd()  # jobs.py sets cwd to the geometry checkout
sys.path.insert(0, str(TRELLIS_ROOT / "TRELLIS.2"))
sys.path.insert(0, str(TRELLIS_ROOT))  # backends/ package (texture baker)
sys.path.append(str(TRELLIS_ROOT / "stubs"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# The TEXTURE baker lives in the trellis-mac checkout (`backends/`), which the
# MLX checkout does not carry. When geometry runs from the MLX tree the cwd is
# trellis2-apple, so `from backends.texture_baker import …` failed with
# "No module named 'backends'" and texturing died AFTER the mesh was built.
# Add the sibling checkout so both trees' modules resolve regardless of which
# one geometry came from.
_SIBLING_TRELLIS = TRELLIS_ROOT.parent / "trellis-mac"
if _SIBLING_TRELLIS != TRELLIS_ROOT and (_SIBLING_TRELLIS / "backends").is_dir():
    sys.path.append(str(_SIBLING_TRELLIS))
    sys.path.append(str(_SIBLING_TRELLIS / "stubs"))

from _progress import ROUTER, artifact, emit, patch_tqdm, progress, stage_done  # noqa: E402

try:
    import flex_gemm  # noqa: F401

    os.environ.setdefault("SPARSE_CONV_BACKEND", "flex_gemm")
except (ImportError, RuntimeError):
    os.environ.setdefault("SPARSE_CONV_BACKEND", "none")

patch_tqdm()
ROUTER.default_stage = "geometry"
# All three samplers run BEFORE any mesh exists, so all three are the geometry
# stage — routing "texture slat" to the texture stage lit the Modeled chunk
# green ~7s before the model appeared in the viewport. The spans lay the loops
# end to end so the geometry bar climbs 0→100 once instead of three times.
ROUTER.desc_map = {
    "sparse structure": ("geometry", "Sampling sparse structure", (0.0, 0.34)),
    "shape slat": ("geometry", "Sampling shape latents", (0.34, 0.67)),
    "texture slat": ("geometry", "Sampling texture latents", (0.67, 1.0)),
}

class WorkerFailure(Exception):
    """A failure whose `error` event has ALREADY been emitted.

    Lets `run_one` fail without deciding how the process should end: the
    one-shot path exits non-zero (jobs.py turns that into a job error), while a
    `--serve` worker stays alive so the next job doesn't re-pay the model load.
    """


WATCHDOG_SIGNATURES = ("non-zero size", "BVH needs at least 8 triangles")
WATCHDOG_HELP = (
    "The Metal GPU watchdog killed a long-running kernel (empty mesh). "
    "Try a lower resolution, or retry with fewer windows/displays active."
)


# What the VIEWER is handed for the geometry-first push. The raw marching-cubes
# mesh is not a preview: a measured 1024_cascade run produced 14,264,186
# triangles / 256 MB, and pushing that at the renderer wedged the window for
# minutes (the user's "the app freezes completely"). The full-resolution file is
# still written and is still what downstream stages consume — only what gets
# DISPLAYED is capped.
PREVIEW_FACE_BUDGET = 240_000


# Fraction of the mesh's faces below which a connected component is treated as
# debris rather than a part of the model. 0.1% of a 3M-face mesh is ~3k faces;
# real parts are far bigger, specks far smaller.
DEBRIS_FACE_FRACTION = 0.001


def drop_debris(tm, label: str):
    """Remove disconnected speck components from a generated mesh.

    MEASURED on a 512 tank run: `geometry.glb` came back as **10,981 connected
    components** with the largest holding only 77% of the faces — i.e. a mostly
    correct model surrounded by ~11k floaters. That debris is what made the
    viewport look like confetti, and it is far worse after decimation, which
    spends its face budget on the specks and shatters the main body (the preview
    measured 20,257 components, largest just 27.7%).

    So drop components below {@link DEBRIS_FACE_FRACTION} of the total. The
    threshold is deliberately tiny — real multi-part models (a turret, separate
    treads) are orders of magnitude larger than a speck, so they survive. Returns
    the mesh unchanged if anything goes wrong: cleanup must never fail a run.
    """
    try:
        comps = tm.split(only_watertight=False)
    except Exception:  # noqa: BLE001
        return tm
    if len(comps) <= 1:
        return tm
    import trimesh as _tm

    total = max(1, len(tm.faces))
    keep = [c for c in comps if len(c.faces) >= total * DEBRIS_FACE_FRACTION]
    if not keep:  # everything looked like debris — keep the biggest component
        keep = [max(comps, key=lambda c: len(c.faces))]
    if len(keep) == len(comps):
        return tm
    merged = _tm.util.concatenate(keep)
    # Report under whatever stage is running — hardcoding "geometry" pulled the
    # UI back to the Modeling chunk for the whole texture bake.
    progress(
        ROUTER.default_stage,
        f"Cleaned {label} — dropped {len(comps) - len(keep):,} stray fragments "
        f"({len(tm.faces) - len(merged.faces):,} faces)",
    )
    return merged


def weld_and_clean(mesh_out, label: str):
    """Weld the raw TRELLIS mesh and strip its debris, ONCE per generation.

    Everything downstream needs this first, for two reasons that share one fix:

      * The raw mesh carries render-duplicated vertices, so its triangles do not
        share vertices and quadric decimation cannot collapse an edge between
        them — it shreds the surface into islands instead of simplifying it.
      * Even welded, the mesh arrives with thousands of stray specks that eat
        the decimator's face budget and speckle the result.

    MEASURED on an F-22 through the real UI, counting components by POSITION
    (a textured mesh is duplicated at every UV seam, so trimesh's default merge
    reports the atlas charts rather than the geometry): the textured model went
    from **5,033 components / largest 92.3%** to **817 / 98.0%** once the bake
    ran on a welded, de-specked mesh — that 7.7% of loose faces is the black
    speckle over the wings.

    Returns arrays in TRELLIS's ORIGINAL frame: the texture bake samples
    voxel-space coords/attrs and must not see the Y-up rotation, which each
    exporter applies for itself.
    """
    import numpy as np
    import trimesh

    tm = trimesh.Trimesh(
        vertices=mesh_out.vertices.cpu().numpy(),
        faces=mesh_out.faces.cpu().numpy(),
        process=False,
    )
    tm.merge_vertices()
    tm = drop_debris(tm, label)
    return np.asarray(tm.vertices), np.asarray(tm.faces)


def to_gltf_up(verts):
    """TRELLIS emits Z-up; glTF is Y-up by spec. Convert (x,y,z) → (x, z, -y).

    jedd: "why is the plane on its nose… it seems suspiciously perfect 90
    degrees… are you sure it generates Y up as opposed to z up". He was right,
    and it is not model-side. MEASURED on a tank, identical on BOTH backends
    (so it is TRELLIS's convention, not ours): extents X=0.516 Y=1.000 Z=0.603
    — the vehicle's LENGTH lay along Y, and a Y-up viewer therefore stood it on
    its nose. After the conversion: X=0.516 Y=0.603 Z=1.000, i.e. length along
    Z and height along Y, and the render sits flat on its tracks.
    """
    import numpy as np

    v = np.asarray(verts)
    return np.column_stack([v[:, 0], v[:, 2], -v[:, 1]])


def from_gltf_up(verts):
    """Inverse of to_gltf_up: (x, y, z) → (x, -z, y).

    A mesh read back from one of our GLBs is Y-up, but the voxel volume the
    colours are sampled from is in TRELLIS's original frame, so a standalone
    bake has to go back before it can sample.
    """
    import numpy as np

    v = np.asarray(verts)
    return np.column_stack([v[:, 0], -v[:, 2], v[:, 1]])


def save_voxels(mesh_out, out_path: Path) -> None:
    """Persist the voxel colour volume beside the mesh.

    This is what lets the Texture stage run on its own — re-baking an edited or
    retopologised mesh without regenerating it, and without a second 11.4 GB
    texture model on disk (jedd: "if trellis bundles a texturing model that can
    do good pbr and such, can you just utilize that instead of a separate
    hunyuan paint please"). The baker samples by POSITION, so any mesh in the
    same frame can be textured from this — which is exactly what retopo → texture
    needs. Stored as fp16: it is a colour field, and half the bytes.
    """
    import numpy as np

    try:
        np.savez_compressed(
            out_path,
            coords=mesh_out.coords.cpu().numpy().astype(np.int32),
            attrs=mesh_out.attrs.cpu().numpy().astype(np.float16),
            origin=mesh_out.origin.cpu().numpy().astype(np.float32),
            voxel_size=np.asarray(mesh_out.voxel_size, dtype=np.float32),
            layout=np.asarray(str(mesh_out.layout)),
        )
    except Exception as err:  # noqa: BLE001 — a missing sidecar is not a failed run
        progress("texture", f"could not save voxel colours for re-texturing ({err})")


def export_untextured_glb(verts, faces, out_path: Path) -> tuple[int, int]:
    """Write the full-resolution geometry, rotated into glTF's Y-up."""
    import trimesh

    tm = trimesh.Trimesh(vertices=to_gltf_up(verts), faces=faces, process=False)
    tm.export(str(out_path))
    # Report what was actually WRITTEN, not the pre-weld input: the raw vertex
    # count is inflated by the duplicates weld_and_clean merged away.
    return int(len(tm.vertices)), int(len(tm.faces))


def export_preview_glb(verts, faces, out_path: Path, full_faces: int) -> Path | None:
    """A viewer-sized copy of the geometry. Returns None when the full mesh is
    already small enough to display directly.

    Takes the ALREADY welded + de-specked mesh, which is what makes decimation
    work at all: on a raw mesh the triangles do not share vertices, so quadric
    decimation cannot collapse an edge between two of them and shreds the
    surface into islands instead of simplifying it (measured on an icosphere
    re-emitted unwelded: 1,029 disconnected bodies at 2,048 faces, versus 1
    welded — the same face count, but confetti instead of a model). That
    confetti is what the viewer used to show, and jedd read it as the model
    itself: "the model is capable of much higher quality results, something is
    going wrong at inference" — it was the preview, not inference.
    """
    if full_faces <= PREVIEW_FACE_BUDGET:
        return None
    import trimesh

    try:
        tm = trimesh.Trimesh(vertices=to_gltf_up(verts), faces=faces, process=False)
        reduced = tm.simplify_quadric_decimation(face_count=PREVIEW_FACE_BUDGET)
        # Decimation detaches a few new slivers of its own (measured: 660
        # components / 1.7% of faces on an already-clean input) — sweep again.
        reduced = drop_debris(reduced, "preview")
        reduced.export(str(out_path))
        progress(
            "geometry",
            f"Preview ready — {len(reduced.faces):,} of {full_faces:,} triangles",
        )
        return out_path
    except Exception as err:  # noqa: BLE001 — a preview must never fail the run
        progress("geometry", f"preview simplification unavailable ({err})")
        return None


# A TRELLIS surface is stair-stepped voxel faces, so adjacent triangles differ
# by ~90° and xatlas splits a chart at nearly every edge — the atlas ends up as
# tens of thousands of tiny islands rather than a few big ones. Each island then
# needs its own padding, so the texel budget has to be counted PER FACE.
#
# MEASURED at 1024px on a 200k-face helicopter: 1,048,576 texels / 200,000 faces
# = 5 texels per face, i.e. ~2x2 including padding. The extracted atlas was
# almost entirely seam bleed, which is what jedd saw as "texturing is completely
# messed up" — the bake was right, the sheet was far too small to hold it.
MIN_TEXELS_PER_FACE = 64

# Triangles handed to the baker, when the caller does not say.
#
# This was 65,000, chosen as "exactly what a 2048 atlas holds at 64 texels per
# face" — which optimised the atlas and quietly capped the MODEL. jedd hit it
# from the other end: every generation came back at exactly 65,000 faces and
# visibly softer than the HF demo, whose decimation target defaults to 300,000
# and which returned 288,000 for the same input image. A budget that is always
# the binding constraint is not a budget, it is a hidden resolution setting.
#
# 300,000 matches the reference. At 4096² that is ~56 texels/face, just under
# the 64 target, so atlas_size_for lands on 4096 and the extra detail is real
# rather than smeared. The cost is what the old comment recorded for 200k/4096:
# minutes rather than seconds, and a GLB in the tens of MB. That is the right
# default for a tool whose output is the deliverable, and the UI's Face limit
# control now actually reaches this (it did not before — see jobs.py), so the
# cheap-and-soft end of the trade is one click away instead of mandatory.
BAKE_FACE_BUDGET = 300_000

# The Metal baker (o_voxel + mtldiffrast) does not survive real volumes on this
# machine: MEASURED three times on a 1.28M-voxel helicopter it failed every
# time — twice with an allocation error ("Invalid buffer size: 14.75 GiB", then
# "MPS backend out of memory … tried to allocate 6.69 GiB") and once by dying
# outright at 4096px, leaving no file and no error. The KDTree baker produces
# the same channels, is verified correct, and cannot take the process with it,
# so it is the default. Set PI_GEN3D_METAL_BAKE=1 to try Metal first.
METAL_BAKE = os.environ.get("PI_GEN3D_METAL_BAKE", "0") == "1"


def undo_baker_gamma(base_color_img):
    """Cancel the linear->sRGB conversion the KDTree baker applies.

    TRELLIS's voxel base_color attribute is ALREADY display-referred. The
    reference pipeline — o_voxel.postprocess.to_glb, which is what the HF demo
    runs — writes it straight out:

        base_color = np.clip(attrs[..., base_color] * 255, 0, 255).astype(uint8)

    trellis-mac's KDTree baker instead does `np.power(base_color, 1/2.2)` before
    quantising (backends/texture_baker.py). That is a second gamma on top of the
    one already baked in, and it only lifts values — 0.20 -> 0.48, 0.50 -> 0.73 —
    so every colour drifts toward white and loses saturation. It is why our
    output looked washed out beside the demo's saturated blues and golds.

    The baker is upstream (a git checkout we provision, not our file), so this
    inverts it here rather than editing a dependency that re-provisioning would
    overwrite. Exact inverse, applied to the uint8 the baker hands back.
    """
    import numpy as np

    linear = (base_color_img.astype(np.float32) / 255.0) ** 2.2
    return np.clip(linear * 255.0 + 0.5, 0, 255).astype(np.uint8)


def atlas_size_for(n_faces: int, requested: int) -> int:
    """The smallest power-of-two atlas that gives each face room to breathe."""
    import math

    need = math.sqrt(max(1, n_faces) * MIN_TEXELS_PER_FACE)
    size = 1 << math.ceil(math.log2(max(need, 1024.0)))
    # Never go BELOW what was asked for, and never past 4096 — beyond that the
    # PNGs cost more than the detail is worth at these mesh densities.
    return int(min(4096, max(requested, size)))


class VoxelVolume(NamedTuple):
    """The colour field a bake samples — from a live generation or from disk."""

    coords: object
    attrs: object
    origin: object
    voxel_size: float
    layout: object


def volume_of(mesh_out) -> VoxelVolume:
    return VoxelVolume(
        coords=mesh_out.coords.cpu(),
        attrs=mesh_out.attrs.cpu(),
        origin=mesh_out.origin.cpu(),
        voxel_size=mesh_out.voxel_size,
        layout=mesh_out.layout,
    )


def load_voxels(path: Path) -> VoxelVolume:
    """Read back a volume saved by save_voxels (see the Texture stage)."""
    import numpy as np
    import torch

    z = np.load(path, allow_pickle=False)
    return VoxelVolume(
        coords=torch.from_numpy(z["coords"]),
        attrs=torch.from_numpy(z["attrs"].astype(np.float32)),
        origin=torch.from_numpy(z["origin"]),
        voxel_size=float(z["voxel_size"]),
        layout=str(z["layout"]),
    )


def bake_textures(
    volume: VoxelVolume,
    verts,
    faces,
    out_path: Path,
    texture_size: int,
    face_budget: int = 0,
) -> None:
    """Metal bake via o_voxel/mtldiffrast, KDTree fallback — adapted from
    trellis-mac generate.py (incl. its _grid_sample_3d transpose fix).

    `verts`/`faces` are the welded, de-specked surface (weld_and_clean), in
    TRELLIS's original frame — the colours are sampled by POSITION out of
    `volume`, so the two have to agree before the Y-up rotation is applied.
    Taking the volume as an argument rather than reaching into a live pipeline
    result is what lets the Texture stage re-bake a mesh on its own.
    """
    import torch
    from PIL import Image as PILImage

    use_metal = False
    try:
        if not METAL_BAKE:
            raise ImportError  # opt-in only — see METAL_BAKE
        import o_voxel.postprocess

        backend = getattr(o_voxel.postprocess, "_BACKEND", None)
        has_dr = getattr(o_voxel.postprocess, "_HAS_DR", False)
        use_metal = backend == "metal" and has_dr
        if use_metal and not getattr(o_voxel.postprocess, "_HAS_FLEX_GEMM", False):
            import torch.nn.functional as F_gs

            def _gs3d_fix(feats, coords, shape, grid, mode="trilinear"):
                B, C = shape[0], shape[1]
                D, H, W = shape[2], shape[3], shape[4]
                dense = torch.zeros(B, C, D, H, W, dtype=feats.dtype, device=feats.device)
                bi = coords[:, 0].long()
                cx = coords[:, 1].long()
                cy = coords[:, 2].long()
                cz = coords[:, 3].long()
                dense[bi, :, cx, cy, cz] = feats
                grid_norm = torch.stack(
                    [
                        grid[..., 2] / (W - 1) * 2 - 1,
                        grid[..., 1] / (H - 1) * 2 - 1,
                        grid[..., 0] / (D - 1) * 2 - 1,
                    ],
                    dim=-1,
                ).reshape(B, 1, 1, -1, 3)
                sampled = F_gs.grid_sample(
                    dense, grid_norm, mode="bilinear", align_corners=True, padding_mode="border"
                )
                M = grid.shape[1]
                return sampled.reshape(B, C, M).permute(0, 2, 1).reshape(B * M, C)

            o_voxel.postprocess._grid_sample_3d = _gs3d_fix
    except (ImportError, AttributeError):
        use_metal = False

    coords, attrs, layout = volume.coords, volume.attrs, volume.layout
    voxel_size = volume.voxel_size
    target_faces = min(face_budget or BAKE_FACE_BUDGET, len(faces))
    size = atlas_size_for(target_faces, texture_size)

    if use_metal:
        try:
            progress("texture", f"Baking PBR textures via Metal ({size}px)…")
            import fast_simplification
            import o_voxel

            verts_np, faces_np = verts, faces
            if len(faces_np) > target_faces:
                ratio = 1.0 - (target_faces / len(faces_np))
                simp_verts, simp_faces = fast_simplification.simplify(verts_np, faces_np, ratio)
                simp_verts_t = torch.from_numpy(simp_verts).float()
                simp_faces_t = torch.from_numpy(simp_faces.astype("int32"))
            else:
                simp_verts_t = torch.from_numpy(verts_np).float()
                simp_faces_t = torch.from_numpy(faces_np.astype("int32"))
            glb = o_voxel.postprocess.to_glb(
                vertices=simp_verts_t.cpu(),
                faces=simp_faces_t.cpu(),
                attr_volume=attrs,
                coords=coords,
                attr_layout=layout,
                voxel_size=voxel_size,
                aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                decimation_target=target_faces,
                texture_size=size,
                verbose=True,
            )
            glb.export(str(out_path))
            return
        except RuntimeError as err:
            progress("texture", f"Metal bake failed ({err}); falling back to KDTree baker…")

    progress("texture", f"Baking PBR textures via KDTree ({size}px)…")
    from backends.texture_baker import bake_texture, export_glb_with_texture, uv_unwrap

    bake_verts, bake_faces = verts, faces
    if len(faces) > target_faces:
        try:
            import fast_simplification

            ratio = 1.0 - (target_faces / len(faces))
            bake_verts, bake_faces = fast_simplification.simplify(verts, faces, ratio)
        except ImportError:
            pass
    new_verts, new_faces, uvs, _ = uv_unwrap(bake_verts, bake_faces)
    base_color_img, mr_img, _mask = bake_texture(
        new_verts,
        new_faces,
        uvs,
        coords.float().numpy(),
        attrs.float().numpy(),
        volume.origin.float().numpy(),
        voxel_size,
        texture_size=size,
    )
    base_color_img = undo_baker_gamma(base_color_img)
    PILImage.fromarray(base_color_img)  # touch to validate
    # FLIP V FOR EXPORT — this is the bug behind "texturing is completely messed
    # up". The baker rasterizes into an image array, so its v runs DOWNWARD with
    # the rows; trimesh's TextureVisuals takes UVs in the OBJ/OpenGL convention
    # where v runs UPWARD, and flips them itself when it writes the GLB. The two
    # flips do not cancel — they compose into an upside-down lookup, and because
    # the atlas is thousands of small charts, "upside down" does not read as a
    # mirrored texture but as coloured static.
    #
    # PROVEN by rewriting the UVs of an already-exported model.glb and reloading
    # it: identical bytes otherwise, and the helicopter went from static to a
    # correctly painted light-blue airframe with grey rotors and yellow trim.
    # Only the EXPORT is flipped; bake_texture above must keep the baker's own
    # convention or the atlas it produces would be wrong too.
    import numpy as np

    export_uvs = np.column_stack([uvs[:, 0], 1.0 - uvs[:, 1]])
    # Rotate to glTF's Y-up ONLY at export: the bake above samples voxel-space
    # coords/attrs/origin, which must stay in TRELLIS's original frame or the
    # texture lands on the wrong faces. A rigid rotation leaves UVs and face
    # indices untouched, so converting the positions here is safe.
    export_glb_with_texture(
        to_gltf_up(new_verts), new_faces, export_uvs, base_color_img, mr_img, str(out_path)
    )


def load_pipeline():
    """Load TRELLIS-2 — MLX when this checkout provides it, else PyTorch MPS.

    MEASURED on the same image at 512, output meshes rendered and compared
    side by side (visually indistinguishable — same turret, barrel, wheels):

        PyTorch MPS   225s total   (82s load + 137s generate)
        MLX            76s total   ( 3s load +  73s generate)   ← 3x faster

    The load alone is 82s → 3s, which matters twice over: it is 36% of a cold
    MPS run, and it is what `--serve` exists to amortise.
    """
    t0 = time.time()
    mlx_pipeline = os.environ.get("PI_GEN3D_MLX_WEIGHTS", "")
    if mlx_pipeline:
        progress("geometry", "Loading TRELLIS-2 (MLX)…")
        from mlx_backend.pipeline import create_mlx_pipeline

        pipeline = create_mlx_pipeline(weights_path=mlx_pipeline)
        # BiRefNet ships fp16 weights while the preprocessing transform yields
        # fp32 — the conv then dies with "Input type (float) and bias type
        # (c10::Half) should be the same". It is tiny next to the 4B pipeline,
        # so promote it rather than downcast the image.
        try:
            pipeline.rembg_model.model.float()
        except Exception:  # noqa: BLE001 — never fail a run over the matte model
            pass
    else:
        progress("geometry", "Loading TRELLIS-2 pipeline (first load ≈100 s)…")
        import torch

        from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline

        pipeline = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
        pipeline.to(torch.device("mps"))
    progress("geometry", f"Pipeline loaded in {time.time() - t0:.0f}s — generating…")
    return pipeline


def run_bake_only(args) -> None:
    """Re-bake an EXISTING mesh from a saved colour volume — the Texture stage.

    This is what replaced Hunyuan Paint (11.4 GB of weights: the paintpbr subset
    plus dinov2-giant) for texturing. TRELLIS already produces PBR for the model
    it generates, and the volume it sampled is small enough to keep, so
    texturing a mesh again — after a retopo, say — needs no second model at all.
    jedd: "if trellis bundles a texturing model that can do good pbr and such,
    can you just utilize that instead of a separate hunyuan paint please (shaves
    off a bit of disk space too)".

    It only works on a mesh this app generated: the volume is the generation's
    own output. An imported mesh has no colours to sample and says so, rather
    than emitting an untextured GLB and calling it done.
    """
    import trimesh

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ROUTER.default_stage = "texture"

    voxels = Path(args.voxels) if args.voxels else Path(args.mesh).with_name("voxels.npz")
    if not voxels.exists():
        msg = (
            "This model has no colour data to texture from — the Texture stage "
            "re-bakes models generated here, and this one was imported."
        )
        emit(event="error", message=msg)
        raise WorkerFailure(msg)

    progress("texture", "Loading colours…")
    volume = load_voxels(voxels)
    tm = trimesh.load(args.mesh, force="mesh", process=False)
    tm.merge_vertices()
    # The GLB on disk is Y-up; the volume is in TRELLIS's frame.
    verts = from_gltf_up(tm.vertices)
    model_path = out_dir / "model.glb"
    bake_textures(volume, verts, tm.faces, model_path, args.texture_size, args.bake_faces)
    artifact("texture", "model-glb", str(model_path), "Textured model")
    stage_done("texture", "Texturing done")


def run_one(pipeline, args) -> None:
    """One generation against an already-loaded pipeline."""
    from PIL import Image as PILImage

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # Per-request reset: a served worker survives across jobs, and the texture
    # branch below mutates the router's default stage. Without this, job N+1's
    # early progress would be misrouted to 'texture'.
    ROUTER.default_stage = "geometry"

    imgs = [PILImage.open(p) for p in args.image]
    if len(imgs) > 1:
        progress("geometry", f"Conditioning on {len(imgs)} images…")
    tex_params = {} if args.texture else {"steps": 1}
    t_gen = time.time()
    try:
        # Multiple images → multi-image conditioning when the pipeline supports
        # it (upstream `run_multi_image`); otherwise fall back to the first view.
        if len(imgs) > 1 and hasattr(pipeline, "run_multi_image"):
            outputs = pipeline.run_multi_image(
                imgs,
                seed=args.seed,
                pipeline_type=args.pipeline_type,
                tex_slat_sampler_params=tex_params,
            )
        else:
            outputs = pipeline.run(
                imgs[0],
                seed=args.seed,
                pipeline_type=args.pipeline_type,
                tex_slat_sampler_params=tex_params,
            )
    except (IndexError, AssertionError) as err:
        if any(sig in str(err) for sig in WATCHDOG_SIGNATURES):
            emit(event="error", message=WATCHDOG_HELP)
            raise WorkerFailure(WATCHDOG_HELP) from err
        raise
    mesh_out = outputs[0] if isinstance(outputs, list) else outputs

    # Weld + de-speck ONCE, then hand the same surface to every consumer. Doing
    # it per-export cost a MEASURED 87s on a 512 run (206s vs 119s) for three
    # identical passes over a 1.5M-face mesh.
    clean_verts, clean_faces = weld_and_clean(mesh_out, "geometry")

    geo_path = out_dir / "geometry.glb"
    n_verts, n_faces = export_untextured_glb(clean_verts, clean_faces, geo_path)
    if n_verts == 0 or n_faces == 0:
        emit(event="error", message=WATCHDOG_HELP)
        raise WorkerFailure(WATCHDOG_HELP)
    # The viewer gets the preview; `path` stays the full-resolution mesh so
    # every downstream stage still runs on the real geometry.
    preview = export_preview_glb(
        clean_verts, clean_faces, out_dir / "geometry-preview.glb", n_faces
    )
    emit(
        event="artifact",
        stage="geometry",
        kind="model-glb",
        path=str(geo_path),
        label="Untextured geometry",
        **({"previewPath": str(preview)} if preview is not None else {}),
    )
    stage_done(
        "geometry",
        f"Geometry done — {n_verts:,} vertices / {n_faces:,} triangles in {time.time() - t_gen:.0f}s",
    )

    if args.texture and getattr(mesh_out, "attrs", None) is not None:
        # Bake-time tqdm loops (simplify/xatlas inside o_voxel) carry no
        # recognizable desc — route them to the texture stage from here on so
        # overallPercent never jumps back to the geometry band.
        ROUTER.default_stage = "texture"
        model_path = out_dir / "model.glb"
        # Keep the colour field beside the result so the Texture stage can
        # re-bake this asset later without regenerating it.
        save_voxels(mesh_out, out_dir / "voxels.npz")
        bake_textures(
            volume_of(mesh_out), clean_verts, clean_faces, model_path,
            args.texture_size, args.bake_faces,
        )
        artifact("texture", "model-glb", str(model_path), "Textured model")
        stage_done("texture", "Texturing done")


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    # One-or-more unlabeled input images (repeat --image). TRELLIS.2 pools
    # multiple views; a single image is the common case.
    ap.add_argument("--image", action="append", dest="image")
    ap.add_argument("--out-dir")
    ap.add_argument(
        "--pipeline-type",
        default="512",
        choices=["512", "1024", "1024_cascade", "1536_cascade"],
    )
    tex = ap.add_mutually_exclusive_group()
    tex.add_argument("--texture", action="store_true", default=True)
    tex.add_argument("--no-texture", dest="texture", action="store_false")
    ap.add_argument("--texture-size", type=int, default=1024)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--prompt", default="")
    # Persistent mode: load the pipeline once, then take one job per stdin line.
    ap.add_argument("--serve", action="store_true")
    # Texture stage: re-bake an existing mesh, no pipeline load at all.
    ap.add_argument("--bake-only", action="store_true")
    ap.add_argument("--mesh")
    ap.add_argument("--voxels")
    ap.add_argument("--bake-faces", type=int, default=0)
    return ap


def _serve(ap: argparse.ArgumentParser) -> None:
    """Read one job per line on stdin, reusing the loaded pipeline.

    Each line is a JSON array of the SAME CLI args a one-shot run would take, so
    the request shape has exactly one definition. After each job we emit
    `{"event":"job-done"}` — the manager's terminator — and a failure is reported
    as an `error` event WITHOUT exiting, so one bad job never costs the 82s
    reload for the next.
    """
    pipeline = load_pipeline()
    emit(event="ready")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            args = ap.parse_args(json.loads(line))
        except Exception as err:  # malformed request — report, stay alive
            emit(event="error", message=f"bad request: {err}")
            emit(event="job-done")
            continue
        try:
            run_one(pipeline, args)
        except WorkerFailure:
            pass  # already reported by run_one
        except Exception as err:
            emit(event="error", message=str(err))
        emit(event="job-done")


def main() -> None:
    ap = _build_parser()
    args = ap.parse_args()
    if args.serve:
        _serve(ap)
        return
    if args.bake_only:
        if not args.mesh or not args.out_dir:
            ap.error("--bake-only needs --mesh and --out-dir")
        try:
            run_bake_only(args)
        except WorkerFailure:
            sys.exit(2)
        return
    if not args.image or not args.out_dir:
        ap.error("--image and --out-dir are required")
    try:
        run_one(load_pipeline(), args)
    except WorkerFailure:
        sys.exit(2)  # error already emitted; jobs.py surfaces the non-zero exit


if __name__ == "__main__":
    main()
