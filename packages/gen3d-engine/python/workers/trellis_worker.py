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
ROUTER.desc_map = {
    "sparse structure": ("geometry", "Sampling sparse structure"),
    "shape slat": ("geometry", "Sampling shape latents"),
    "texture slat": ("texture", "Sampling texture latents"),
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
    progress(
        "geometry",
        f"Cleaned {label} — dropped {len(comps) - len(keep):,} stray fragments "
        f"({len(tm.faces) - len(merged.faces):,} faces)",
    )
    return merged


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


def export_untextured_glb(mesh_out, out_path: Path) -> tuple[int, int]:
    import trimesh

    verts = to_gltf_up(mesh_out.vertices.cpu().numpy())
    faces = mesh_out.faces.cpu().numpy()
    # Default process=True, so trimesh MERGES the render-duplicated vertices the
    # raw mesh carries — this file is welded and intact (unlike the preview,
    # which used to skip that; see export_preview_glb).
    tm = trimesh.Trimesh(vertices=verts, faces=faces)
    tm = drop_debris(tm, "geometry")
    tm.export(str(out_path))
    # Report what was actually WRITTEN, not the pre-weld input: the raw vertex
    # count is inflated by the duplicates trimesh just merged away.
    return int(len(tm.vertices)), int(len(tm.faces))


def export_preview_glb(mesh_out, out_path: Path, full_faces: int) -> Path | None:
    """A viewer-sized copy of the geometry. Returns None when the full mesh is
    already small enough to display directly."""
    if full_faces <= PREVIEW_FACE_BUDGET:
        return None
    import trimesh

    try:
        tm = trimesh.Trimesh(
            vertices=to_gltf_up(mesh_out.vertices.cpu().numpy()),
            faces=mesh_out.faces.cpu().numpy(),
            process=False,
        )
        # WELD BEFORE DECIMATING. The raw mesh carries render-duplicated
        # vertices (a marching-cubes/GLB export repeats positions per face), so
        # with `process=False` its triangles do not SHARE vertices — quadric
        # decimation cannot collapse an edge between two triangles that have no
        # common vertex, so instead of simplifying the surface it shreds it into
        # islands. MEASURED on an icosphere re-emitted unwelded: decimating to
        # 2,048 faces gave 1,029 disconnected bodies and watertight=False,
        # versus 1 body / watertight=True after merge_vertices() — the same face
        # count, but confetti instead of a model. That confetti is what the
        # viewer was showing (jedd: "the model is capable of much higher quality
        # results, something is going wrong at inference" — it was the PREVIEW,
        # not inference). Same root cause the retopo path already fixes by
        # welding before AutoRemesher.
        tm.merge_vertices()
        # Strip debris BEFORE decimating: quadric decimation spends its budget
        # per-component, so ~11k specks starve the real surface — measured, the
        # preview's largest component fell to 27.7% of the mesh.
        tm = drop_debris(tm, "preview")
        reduced = tm.simplify_quadric_decimation(face_count=PREVIEW_FACE_BUDGET)
        reduced.export(str(out_path))
        progress(
            "geometry",
            f"Preview ready — {len(reduced.faces):,} of {full_faces:,} triangles",
        )
        return out_path
    except Exception as err:  # noqa: BLE001 — a preview must never fail the run
        progress("geometry", f"preview simplification unavailable ({err})")
        return None


def bake_textures(mesh_out, out_path: Path, texture_size: int) -> None:
    """Metal bake via o_voxel/mtldiffrast, KDTree fallback — adapted from
    trellis-mac generate.py (incl. its _grid_sample_3d transpose fix)."""
    import torch
    from PIL import Image as PILImage

    use_metal = False
    try:
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

    if use_metal:
        try:
            progress("texture", f"Baking PBR textures via Metal ({texture_size}px)…")
            import fast_simplification
            import o_voxel

            verts_np = mesh_out.vertices.cpu().numpy()
            faces_np = mesh_out.faces.cpu().numpy()
            target_faces = min(200_000, len(faces_np))
            if len(faces_np) > target_faces:
                ratio = 1.0 - (target_faces / len(faces_np))
                simp_verts, simp_faces = fast_simplification.simplify(verts_np, faces_np, ratio)
                simp_verts_t = torch.from_numpy(simp_verts).float()
                simp_faces_t = torch.from_numpy(simp_faces.astype("int32"))
            else:
                simp_verts_t = mesh_out.vertices
                simp_faces_t = mesh_out.faces
            glb = o_voxel.postprocess.to_glb(
                vertices=simp_verts_t.cpu(),
                faces=simp_faces_t.cpu(),
                attr_volume=mesh_out.attrs.cpu(),
                coords=mesh_out.coords.cpu(),
                attr_layout=mesh_out.layout,
                voxel_size=mesh_out.voxel_size,
                aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                decimation_target=target_faces,
                texture_size=texture_size,
                verbose=True,
            )
            glb.export(str(out_path))
            return
        except RuntimeError as err:
            progress("texture", f"Metal bake failed ({err}); falling back to KDTree baker…")

    progress("texture", f"Baking PBR textures via KDTree ({texture_size}px)…")
    from backends.texture_baker import bake_texture, export_glb_with_texture, uv_unwrap

    verts = mesh_out.vertices.cpu().numpy()
    faces = mesh_out.faces.cpu().numpy()
    bake_verts, bake_faces = verts, faces
    target_faces = min(200_000, len(faces))
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
        mesh_out.coords.cpu().float().numpy(),
        mesh_out.attrs.cpu().float().numpy(),
        mesh_out.origin.cpu().float().numpy(),
        mesh_out.voxel_size,
        texture_size=texture_size,
    )
    PILImage.fromarray(base_color_img)  # touch to validate
    # Rotate to glTF's Y-up ONLY at export: the bake above samples voxel-space
    # coords/attrs/origin, which must stay in TRELLIS's original frame or the
    # texture lands on the wrong faces. A rigid rotation leaves UVs and face
    # indices untouched, so converting the positions here is safe.
    export_glb_with_texture(
        to_gltf_up(new_verts), new_faces, uvs, base_color_img, mr_img, str(out_path)
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

    geo_path = out_dir / "geometry.glb"
    n_verts, n_faces = export_untextured_glb(mesh_out, geo_path)
    if n_verts == 0 or n_faces == 0:
        emit(event="error", message=WATCHDOG_HELP)
        raise WorkerFailure(WATCHDOG_HELP)
    # The viewer gets the preview; `path` stays the full-resolution mesh so
    # every downstream stage still runs on the real geometry.
    preview = export_preview_glb(mesh_out, out_dir / "geometry-preview.glb", n_faces)
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
        bake_textures(mesh_out, model_path, args.texture_size)
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
    if not args.image or not args.out_dir:
        ap.error("--image and --out-dir are required")
    try:
        run_one(load_pipeline(), args)
    except WorkerFailure:
        sys.exit(2)  # error already emitted; jobs.py surfaces the non-zero exit


if __name__ == "__main__":
    main()
