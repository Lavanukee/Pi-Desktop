"""CubePart worker — mesh + part names → per-part meshes (Roblox/cubepart).

Runs inside the cube venv. The pipeline is pure PyTorch (adapted Qwen-Image /
DINOv2 code, no custom CUDA kernels), so `--device mps` is attempted first
with a CPU fallback. Checkpoints come from the HF cache snapshot (offline).

Part names come from the UI's prompt field (comma-separated). Without names
CubePart cannot segment (it is part-CONDITIONED decomposition, not automatic
segmentation), so we default to a generic schema and say so in the message.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _progress import ROUTER, artifact, patch_tqdm, progress, stage_done  # noqa: E402

STAGE = "segment"
DEFAULT_PARTS = ["main body", "top part", "bottom part", "left part", "right part"]

patch_tqdm()
ROUTER.default_stage = STAGE


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mesh", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--cube-dir", required=True)
    ap.add_argument("--parts", default="")
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--guidance-scale", type=float, default=7.5)
    # Upstream default is 8.5; on 24 GB unified memory the shape-VAE
    # extraction attention OOMs at 8.5 AFTER a full 30-step denoise
    # (27.9 GiB allocated, +3 GiB request — reproduced). 7.5 keeps the
    # extraction grid inside the MPS pool.
    ap.add_argument("--resolution-base", type=float, default=7.5)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    parts = [p.strip() for p in args.parts.split(",") if p.strip()] or DEFAULT_PARTS
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    progress(STAGE, "Locating CubePart weights…")
    os.environ.setdefault("HF_HOME", str(Path.home() / ".cache" / "pi-desktop" / "gen3d" / "hf"))
    from huggingface_hub import snapshot_download

    weights = Path(snapshot_download("Roblox/cubepart", local_files_only=True))

    progress(STAGE, "Loading CubePart pipeline (9.9 GB)…")
    import torch
    import trimesh

    sys.path.insert(0, str(Path(args.cube_dir) / "cubepart"))
    from cube_part.pipelines import PartShapeDenoiserPipeline, ShapeInput
    from cube_part.utils.mesh import load_mesh, sample_surface

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    config = Path(args.cube_dir) / "cubepart" / "configs" / "shape_denoiser_multimesh.yaml"
    pipe = PartShapeDenoiserPipeline(
        config_path=str(config),
        checkpoint_path=str(weights / "multi_part_dit.safetensors"),
        vae_checkpoint_path=str(weights / "vae.safetensors"),
        device=device,
        extract_geometry_fn_name="extract_geometry_coarse_to_fine",
    )

    progress(STAGE, "Encoding input mesh…")
    mesh, _, _ = load_mesh(args.mesh)
    surface = sample_surface(mesh, num_samples=128_000)
    # float() BEFORE .to(device): sample_surface yields float64 and MPS
    # cannot receive float64 tensors (verified failure here).
    surface = torch.from_numpy(surface).float().unsqueeze(0).to(pipe.device)
    latents, _ = pipe.encode_shape(surface)

    progress(STAGE, f"Decomposing into {len(parts)} parts ({args.steps} steps)…")
    part_meshes = pipe.input_to_part_shape(
        ShapeInput(prompt=[parts], latents=latents),
        guidance_scale=args.guidance_scale,
        resolution_base=args.resolution_base,
        scheduler_type="dpm_solver",
        num_inference_steps=args.steps,
        seed=args.seed,
        output_mesh=True,
    )

    scene = trimesh.Scene()
    saved = 0
    palette = [
        (231, 76, 60), (46, 204, 113), (52, 152, 219), (241, 196, 15),
        (155, 89, 182), (26, 188, 156), (230, 126, 34), (149, 165, 166),
    ]
    for i, (verts, faces) in enumerate(part_meshes):
        if verts is None:
            continue
        name = parts[i].replace(" ", "_") if i < len(parts) else f"part_{i}"
        submesh = trimesh.Trimesh(verts, faces)
        submesh.visual.face_colors = palette[i % len(palette)]
        submesh.export(str(out_dir / f"part_{i:02d}_{name}.glb"))
        scene.add_geometry(submesh, geom_name=f"part_{i:02d}_{name}")
        saved += 1

    if saved == 0:
        raise RuntimeError("CubePart produced no part meshes")
    combined = out_dir / "parts.glb"
    scene.export(str(combined))
    artifact(STAGE, "model-glb", str(combined), f"Segmented parts ({saved})")
    stage_done(STAGE, f"Segmented into {saved} parts")


if __name__ == "__main__":
    main()
