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
import os
import sys
import time
from pathlib import Path

# --- backend env BEFORE torch/trellis imports (mirrors trellis-mac) ---------
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("ATTN_BACKEND", "sdpa")
os.environ.setdefault("SPARSE_ATTN_BACKEND", "sdpa")

TRELLIS_ROOT = Path.cwd()  # jobs.py sets cwd to the trellis-mac checkout
sys.path.insert(0, str(TRELLIS_ROOT / "TRELLIS.2"))
sys.path.insert(0, str(TRELLIS_ROOT))  # backends/ package (texture baker)
sys.path.append(str(TRELLIS_ROOT / "stubs"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

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

WATCHDOG_SIGNATURES = ("non-zero size", "BVH needs at least 8 triangles")
WATCHDOG_HELP = (
    "The Metal GPU watchdog killed a long-running kernel (empty mesh). "
    "Try a lower resolution, or retry with fewer windows/displays active."
)


def export_untextured_glb(mesh_out, out_path: Path) -> tuple[int, int]:
    import trimesh

    verts = mesh_out.vertices.cpu().numpy()
    faces = mesh_out.faces.cpu().numpy()
    tm = trimesh.Trimesh(vertices=verts, faces=faces)
    tm.export(str(out_path))
    return int(verts.shape[0]), int(faces.shape[0])


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
    export_glb_with_texture(new_verts, new_faces, uvs, base_color_img, mr_img, str(out_path))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--out-dir", required=True)
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
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    progress("geometry", "Loading TRELLIS-2 pipeline (first load ≈100 s)…")
    t0 = time.time()
    import torch
    from PIL import Image as PILImage

    from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline

    pipeline = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
    pipeline.to(torch.device("mps"))
    progress("geometry", f"Pipeline loaded in {time.time() - t0:.0f}s — generating…")

    img = PILImage.open(args.image)
    tex_params = {} if args.texture else {"steps": 1}
    t_gen = time.time()
    try:
        outputs = pipeline.run(
            img,
            seed=args.seed,
            pipeline_type=args.pipeline_type,
            tex_slat_sampler_params=tex_params,
        )
    except (IndexError, AssertionError) as err:
        if any(sig in str(err) for sig in WATCHDOG_SIGNATURES):
            emit(event="error", message=WATCHDOG_HELP)
            sys.exit(2)
        raise
    mesh_out = outputs[0] if isinstance(outputs, list) else outputs

    geo_path = out_dir / "geometry.glb"
    n_verts, n_faces = export_untextured_glb(mesh_out, geo_path)
    if n_verts == 0 or n_faces == 0:
        emit(event="error", message=WATCHDOG_HELP)
        sys.exit(2)
    artifact("geometry", "model-glb", str(geo_path), "Untextured geometry")
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


if __name__ == "__main__":
    main()
