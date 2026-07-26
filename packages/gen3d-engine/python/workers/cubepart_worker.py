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
    ap.add_argument("--chunk-size", type=int, default=25_000)
    ap.add_argument(
        "--dtype", default="float16", choices=["float16", "float32", "bfloat16"]
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

    device = "mps" if torch.backends.mps.is_available() else "cpu"

    # NOT BFLOAT16. CubePart wraps its DiT denoise in
    # `torch.autocast(self.device.type, dtype=torch.bfloat16)`, and bf16 on this
    # backend produced an implicit field that never crosses the iso-surface —
    # every part failed marching cubes with "Surface level must be within volume
    # data range", i.e. no geometry at all, after a full 8-minute denoise.
    #
    # Same failure mode as SkinTokens: bf16 on MPS runs without complaint and
    # returns garbage. Isolating the stages proved the REST of the pipeline is
    # fine on MPS — the VAE round trip reconstructed a 1.57M-vertex mesh and the
    # text encoder produced finite, well-scaled embeddings — which left only the
    # denoise.
    #
    # STILL BROKEN — this is where the investigation stands, not a fix.
    #
    #   bfloat16   30 steps, then every part fails marching cubes
    #   float16    30 steps, then every part fails marching cubes (10 mantissa
    #              bits against bf16's 7 was not enough)
    #   float32    cannot be tested here: the DiT is 8 GB, so fp32 makes it 16 GB
    #              and the run OOMs at 30.1 GiB mid-denoise on 24 GB of unified
    #              memory
    #
    # So BOTH 16-bit formats give a degenerate field and the one that might work
    # does not fit. The next thing to try is keeping the DiT in fp32 while
    # evicting the text encoder and the VAE to CPU for the duration of the
    # denoise — the text encoder runs once before the loop and the VAE only
    # after it, so neither needs to be resident while the DiT is. Failing that,
    # the denoise runs on CPU.
    #
    # `--dtype`, `--chunk-size` and `--resolution-base` are the knobs that
    # investigation needs; chunk-size 20k is what got extraction to complete at
    # all (100k asked for another 6.10 GiB after a successful denoise).
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
        # Disabling autocast is only half of it: the DiT and VAE weights are
        # stored bf16, so fp32 activations then meet bf16 parameters and Metal
        # aborts the process outright ("Destination NDArray and Accumulator
        # NDArray cannot have different datatype"). Cast the weights to match.
        # ONLY the DiT. Casting the whole system doubles the encoder's working
        # set and it OOMs at 30.16 GiB on the 128k-point surface encode — and it
        # is not needed: the VAE was verified correct in bf16 (encode → decode →
        # marching cubes reconstructed a 1.57M-vertex mesh), as was the text
        # encoder. The denoise is the only stage that bf16 breaks.
        try:
            want = torch.float16 if args.dtype == "float16" else torch.float32
            pipe.system.diffusion_model = pipe.system.diffusion_model.to(want)

            # …and cast what is HANDED to it. The latents arrive from the bf16
            # VAE and the text embeddings are fp16, so an fp32 DiT alone still
            # hits a mixed-dtype matmul, which Metal answers by aborting the
            # process rather than raising. Casting at this one boundary keeps
            # the denoise entirely in fp32 while everything else stays bf16.
            _fwd = pipe.system._forward_diffusion_model

            def _fwd_fp32(*a, **kw):
                cast = lambda t: (  # noqa: E731
                    t.to(want) if torch.is_tensor(t) and t.is_floating_point() else t
                )
                return _fwd(*[cast(x) for x in a], **{k: cast(v) for k, v in kw.items()})

            pipe.system._forward_diffusion_model = _fwd_fp32
        except Exception as err:  # noqa: BLE001
            progress(STAGE, f"could not cast the denoiser to fp32 ({err})")

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
