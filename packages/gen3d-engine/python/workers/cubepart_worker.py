"""CubePart worker — mesh + part names → per-part meshes (Roblox/cubepart).

Runs inside the cube venv. The pipeline is pure PyTorch (adapted Qwen-Image /
DINOv2 code, no custom CUDA kernels) but its denoise is broken on MPS at every
dtype, so this stage runs on CPU — see the note in main(). Checkpoints come from
the HF cache snapshot (offline).

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
# CubePart's diffusion loop has no tqdm description, and on CPU it runs for
# ~20 minutes — "Working… (12/30)" for that long tells the user nothing.
ROUTER.fallback_message = "Deciding which surface belongs to which part"



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
    ap.add_argument("--chunk-size", type=int, default=25_000)
    ap.add_argument("--device", default="cpu", choices=["mps", "cpu"])
    ap.add_argument(
        "--dtype",
        default="float32",
        choices=["float32", "bfloat16"],
        help="bfloat16 is upstream's behaviour and is BROKEN on MPS (see above)",
    )
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

    device = args.device if torch.backends.mps.is_available() else "cpu"

    # THE DENOISE IS BROKEN ON MPS AT EVERY DTYPE, SO THIS STAGE RUNS ON CPU.
    #
    #   MPS bfloat16   30 steps, then every part fails marching cubes with
    #                  "Surface level must be within volume data range"
    #   MPS float16    30 steps, same failure
    #   MPS float32    30 steps, same failure
    #   CPU  float32   4 parts, correct     ← default
    #
    # The CPU control settled it, exactly as it did for SkinTokens: same code,
    # same weights, same prompts, only the backend differs. Unlike SkinTokens,
    # dtype was NOT the cure here — all three fail on MPS — so this is an MPS
    # kernel defect inside the DiT rather than a precision problem.
    #
    # Everything AROUND the denoise is fine on MPS, verified individually so the
    # blame lands in one place: the VAE round trip reconstructs a 1.57M-vertex
    # mesh, the text encoder returns finite well-scaled embeddings, decode_shape
    # (the very call the denoise feeds) produces a mesh from encoded latents,
    # and the sampler timesteps are a clean descending 999 → 33.
    #
    # The cost is real — ~21 minutes on CPU against ~8 on MPS — and it is paid by
    # the one stage that has to. `--device mps` is kept so that confirming a
    # future torch release fixes this takes a single run.
    #
    # The autocast/eviction machinery below is what an MPS run NEEDS to get as
    # far as a complete denoise, and is left in place for exactly that retry:
    # the weights are already fp32 (measured: diffusion_model 8.58 GB,
    # shape_model 1.32 GB), so bf16 came purely from the autocast wrapper, and
    # disabling it OOM'd at 30.1 GiB until the 8.88 GB text encoder — larger
    # than the DiT, and used once before the sampling loop — was evicted to CPU.

    if args.dtype != "bfloat16":
        _orig_autocast = torch.autocast

        class _NoAutocast(_orig_autocast):  # type: ignore[misc,valid-type]
            def __init__(self, device_type, *a, **kw):
                kw["enabled"] = False
                super().__init__(device_type, *a, **kw)

        torch.autocast = _NoAutocast

    config = Path(args.cube_dir) / "cubepart" / "configs" / "shape_denoiser_multimesh.yaml"
    pipe = PartShapeDenoiserPipeline(
        config_path=str(config),
        checkpoint_path=str(weights / "multi_part_dit.safetensors"),
        vae_checkpoint_path=str(weights / "vae.safetensors"),
        device=device,
        extract_geometry_fn_name="extract_geometry_coarse_to_fine",
    )

    if args.dtype != "bfloat16":
        _fwd = pipe.system._forward_diffusion_model
        _evicted = []

        def _fwd_lean(*a, **kw):
            if not _evicted and device == "mps":
                # First sampling step: the text conditioning is already computed.
                try:
                    pipe.system.base_model.to("cpu")
                    torch.mps.empty_cache()
                    progress(STAGE, "Freed the text encoder (8.9 GB) for the denoise")
                except Exception as err:  # noqa: BLE001 — never fail a run over this
                    progress(STAGE, f"could not free the text encoder ({err})")
                _evicted.append(True)
            # The DiT is fp32 but the text embeddings arrive fp16 and the
            # latents bf16, and Metal answers a mixed-dtype matmul by aborting
            # the process rather than raising. Cast at this one boundary.
            cast = lambda t: (  # noqa: E731
                t.float() if torch.is_tensor(t) and t.is_floating_point() else t
            )
            return _fwd(*[cast(x) for x in a], **{k: cast(v) for k, v in kw.items()})

        pipe.system._forward_diffusion_model = _fwd_lean

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
        # The extraction grid is the memory peak, not the denoise: fp16 finished
        # all 30 steps at 25.4 GiB and then asked for another 6.10 GiB to decode.
        # Smaller chunks trade a little speed for headroom.
        chunk_size=args.chunk_size,
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
