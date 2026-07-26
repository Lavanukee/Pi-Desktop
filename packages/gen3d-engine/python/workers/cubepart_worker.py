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
import time
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
    # None -> resolved by device below: the small chunks exist for the MPS pool.
    ap.add_argument("--chunk-size", type=int, default=None)
    ap.add_argument("--device", default="mlx", choices=["mlx", "mps", "cpu"])
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

    # "mlx" runs the DiT in MLX and keeps every torch tensor on CPU.
    #
    # Putting the torch side back on MPS once the DiT was in MLX looked free —
    # the denoise is only 155s of a 529s run, the text encode (~148s) and the
    # extraction (~169s) are the larger halves. TRIED IT: 30 steps completed and
    # then "CubePart produced no part meshes". So the Metal problem was never
    # the DiT alone. Measured against CPU on the real inputs, the MPS text
    # encoder differs by 4.7e-3 and the shape VAE encode by 1.9e-4 — the same
    # order as the timestep error that put 1.2e-2 through the DiT, and CFG at
    # 7.5 amplifies a cond/uncond difference rather than cancelling it.
    # MPS also made the denoise SLOWER (7.40 vs 4.26 s/step): every step drags
    # the latents MPS -> CPU -> MLX -> CPU -> MPS with a sync at each hop.
    use_mlx = args.device == "mlx"
    has_mps = torch.backends.mps.is_available()
    device = "cpu" if use_mlx or not has_mps else args.device
    if args.chunk_size is None:
        # 25k is a concession to the MPS pool (extraction, not the denoise, is
        # the memory peak there), so raising it on CPU looked free. MEASURED: at
        # 100k the extraction got SLOWER (~182s vs ~169s on the same mesh), so
        # the small chunks are not costing anything worth reclaiming here.
        args.chunk_size = 25_000

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
    # "all fine" on that last line was a round-trip smoke test, and it was too
    # generous. Compared NUMERICALLY against CPU on the real inputs, the MPS
    # text encoder differs by 4.7e-3 and the shape encode by 1.9e-4 — so the
    # Metal error is spread across the whole pipeline, not localised in the DiT.
    # That is why the MLX port keeps the torch side on CPU (see above) instead
    # of only replacing the denoiser and moving the rest back to Metal.
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

    if use_mlx:
        # The denoise is 27 transformer blocks run `steps` times; everything
        # else in this pipeline runs once. Moving just that to MLX is what
        # turns ~25 min of CPU into ~2 min, without touching the VAE, the text
        # encoder, the scheduler or the extraction.
        progress(STAGE, "Swapping the denoiser to MLX (Metal)…")
        import _cubepart_mlx_bridge

        _cubepart_mlx_bridge.install(pipe.system, weights / "multi_part_dit.safetensors")

    if use_mlx:
        # The text encoder is an 8.9 GB LLM run on CPU, and it is handed one
        # sequence per part SLOT — 9 of them, doubled to 18 by classifier-free
        # guidance. But CubePart pads to 8 parts with "", and the negative
        # prompt is one string repeated, so a 3-part request asks it to encode
        # the same handful of strings over and over. Encoding the distinct ones
        # and reindexing is exact (eval mode, no dropout: same string in, same
        # embedding out) and it was ~148s of a 529s run.
        class _DedupEncoder(torch.nn.Module):
            def __init__(self, inner: torch.nn.Module) -> None:
                super().__init__()
                self.inner = inner  # stays a child module, so .to() still works

            def __getattr__(self, name):
                # The pipeline reaches into the encoder for more than forward()
                # (`.processor`, tokenizers, config). Without this the wrapper
                # is a wall rather than a pass-through.
                try:
                    return super().__getattr__(name)
                except AttributeError:
                    inner = self.__dict__.get("_modules", {}).get("inner")
                    if inner is None:
                        raise
                    return getattr(inner, name)

            def forward(self, prompts, *a, **kw):
                if not isinstance(prompts, (list, tuple)) or not all(
                    isinstance(p, str) for p in prompts
                ):
                    return self.inner(prompts, *a, **kw)
                uniq = list(dict.fromkeys(prompts))
                if len(uniq) == len(prompts):
                    return self.inner(prompts, *a, **kw)
                progress(STAGE, f"Encoding {len(uniq)} distinct prompts (of {len(prompts)})…")
                emb, mask = self.inner(uniq, *a, **kw)
                order = {p: i for i, p in enumerate(uniq)}
                idx = torch.tensor([order[p] for p in prompts], device=emb.device)
                return emb[idx], mask[idx]

        pipe.system.base_model = _DedupEncoder(pipe.system.base_model)

    # Extraction is the largest phase left (~169s of a 335s run at 10 steps),
    # and it looked like the one place Metal was safe: it runs once, after the
    # last denoise step, so there is no trajectory left for its error to
    # compound along. TRIED IT — decode_shape on MPS made the whole run SLOWER,
    # 399s against 335s, and moved the fuselage extent 0.56 -> 0.59. Marching
    # cubes is the bulk of it and cannot move: use_warp needs CUDA, so it falls
    # back to skimage on the CPU on either path, leaving only the field
    # evaluation on-device to pay for shuttling the shape model across.

    # Phase timings, because the shape of this run is not what it looks like:
    # once the DiT is fast, the encode and the extraction are the bill.
    marks: list[tuple[str, float]] = [("load", time.time())]

    def mark(name: str) -> None:
        marks.append((name, time.time()))
        progress(STAGE, f"{name} took {marks[-1][1] - marks[-2][1]:.0f}s")

    progress(STAGE, "Encoding input mesh…")
    mesh, _, _ = load_mesh(args.mesh)
    surface = sample_surface(mesh, num_samples=128_000)
    # float() BEFORE .to(device): sample_surface yields float64 and MPS
    # cannot receive float64 tensors (verified failure here).
    surface = torch.from_numpy(surface).float().unsqueeze(0).to(pipe.device)
    latents, _ = pipe.encode_shape(surface)
    mark("mesh encode")

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
    mark("denoise + extract")

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
