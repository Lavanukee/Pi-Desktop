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

    # THIS STAGE RUNS ON CPU. Not because any single operation is wrong on MPS
    # — every one of them checks out — but because the error they each carry is
    # amplified by classifier-free guidance and compounds over 30 steps.
    #
    #   MPS bfloat16 / float16 / float32   30 steps, then every part fails
    #                                      marching cubes with "Surface level
    #                                      must be within volume data range"
    #   CPU  float32                       4 parts, correct         ← default
    #
    # I first wrote this off as "an MPS kernel defect inside the DiT". That was
    # WRONG, and measuring it properly is what corrected it. One forward pass
    # with identical inputs on each backend:
    #
    #   DiT forward          relative max|diff| 0.005   (std 0.80533 vs 0.80510)
    #   with the part mask   relative max|diff| 0.010, no NaN, no concentration
    #                        in the padded slots
    #   seeded init noise    std 1.0003 vs 1.0004, MPS reproducible
    #   scheduler step()     BIT-IDENTICAL (relative diff 0.000000)
    #   velocity conversion  identical
    #   VAE round trip · text encoder · decode_shape · timesteps   all fine
    #
    # Nothing is broken. But ~1% relative error is LARGE for fp32 — a
    # well-conditioned network should agree with CPU to ~1e-5 — which says the
    # MPS matmuls are not carrying true fp32 precision. Guidance 7.5 multiplies
    # the gap between the conditional and unconditional predictions before it is
    # applied, and thirty steps of that walks the trajectory off-distribution
    # until the decoded field no longer crosses the iso-surface.
    #
    # PREDICTED AND CONFIRMED: at guidance 1.5 the MPS run survives — 3 parts,
    # ~13 min. But it is useless. The parts each span 72-100% of the model on
    # every axis (spread 0.075) because low guidance means the part names barely
    # bite: "rotor blades" came out 1.09 x 1.82 x 1.59 where the correct CPU run
    # gives 1.39 x 0.07 x 1.22 — flat, as blades are. Valid geometry, no
    # decomposition. So there is no fast MPS mode worth shipping.
    #
    # CPU costs ~25 min against ~13. Getting to "seconds" needs an MLX port of
    # the DiT, not a setting. `--device mps` is kept so a future torch release
    # can be retested in one run.

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
