"""Hunyuan Paint worker — PBR texture painting of an existing mesh on MPS via
the Brainkeys/Hunyuan3D-2.1-mac fork (CUDA-free rasterizer fallbacks).

HONESTY NOTE (see FEASIBILITY.md): the paint pipeline is the least mature MPS
path of the engine — community reports show high unified-memory pressure on
24 GB machines. This worker is wired end-to-end but its verification status is
recorded in FEASIBILITY.md; failures surface as real errors, never fake output.

Reference conditioning: Paint wants an image of the target look. We take the
job's prompt image when present, else render nothing and let the pipeline use
its text/image defaults — passing --image explicitly is preferred.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _progress import ROUTER, artifact, patch_tqdm, progress, stage_done  # noqa: E402

STAGE = "texture"

patch_tqdm()
ROUTER.default_stage = STAGE


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mesh", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--tool-dir", required=True)
    ap.add_argument("--image", default="")
    ap.add_argument("--prompt", default="")
    ap.add_argument("--max-view", type=int, default=6)
    ap.add_argument("--resolution", type=int, default=512)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tool_dir = Path(args.tool_dir)
    sys.path.insert(0, str(tool_dir))
    sys.path.insert(0, str(tool_dir / "hy3dpaint"))

    os.environ.setdefault("HF_HOME", str(Path.home() / ".cache" / "pi-desktop" / "gen3d" / "hf"))

    progress(STAGE, "Resolving Hunyuan Paint weights…")
    from huggingface_hub import snapshot_download

    weights = Path(
        snapshot_download(
            "tencent/Hunyuan3D-2.1",
            allow_patterns=["hunyuan3d-paintpbr-v2-1/*", "hy3dpaint/*"],
            local_files_only=True,
        )
    )

    progress(STAGE, "Loading Hunyuan Paint pipeline (6.9 GB)…")
    from textureGenPipeline import Hunyuan3DPaintConfig, Hunyuan3DPaintPipeline

    config = Hunyuan3DPaintConfig(max_num_view=args.max_view, resolution=args.resolution)
    # Point the config at the local snapshot rather than letting it re-download.
    if hasattr(config, "model_path"):
        config.model_path = str(weights)
    pipeline = Hunyuan3DPaintPipeline(config)

    if not args.image or not Path(args.image).exists():
        raise RuntimeError(
            "Hunyuan Paint needs a reference image of the target look — pass the "
            "image path in the texture stage's prompt field."
        )
    progress(STAGE, "Painting textures (multi-view diffusion + PBR bake)…")
    # use_remesh=False: the fork's remesh path needs Blender (bpy), which is
    # not provisioned; painting the mesh as-is works without it.
    result_path = pipeline(
        mesh_path=args.mesh,
        image_path=args.image,
        output_mesh_path=str(out_dir / "painted.glb"),
        use_remesh=False,
    )
    final = Path(result_path) if result_path else out_dir / "painted.glb"
    if not final.exists():
        raise RuntimeError("Hunyuan Paint produced no output mesh")
    artifact(STAGE, "model-glb", str(final), "Painted model")
    stage_done(STAGE, "Texture painting done")


if __name__ == "__main__":
    main()
