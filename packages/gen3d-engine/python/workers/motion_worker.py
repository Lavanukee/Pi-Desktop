"""Text -> human motion, on Metal, offline.

NVIDIA ARDY: autoregressive diffusion over a hybrid motion representation. A
sentence goes in, a moving skeleton comes out.

WHY IT FITS THIS APP WITHOUT A RETARGETING STEP. ARDY's "Core" model speaks
cskel27, and workers/_humanoid.py already emits cskel27 for the rig stage —
VERIFIED joint-for-joint here, not assumed: same 27 names, same order, same
parent indices. A clip generated here drives a rig this app produced, directly.

MEASURED on an M5 Pro (24 GB), 20 fps, 10 denoising steps:
    12s of motion in 2.2s on MPS  (5.6x real time; CPU takes 19.9s)
    4s  of motion in 0.5s on MPS
plus a one-off text encode, which is the expensive part — see below.

THE TEXT ENCODER IS THE COST, AND IT IS CACHED. ARDY conditions on LLM2Vec
embeddings built on Llama-3-8B: 16 GB of weights to turn one sentence into one
vector. MEASURED, and the split is not where it looks — encoding takes ~4s, but
getting the encoder ready takes ~155s, nearly all of it `PeftModel` loading two
LoRA adapters over 16 GB and merging them.

So the embedding is cached on disk, keyed by the prompt: 16 KB of float32 per
sentence buys skipping the entire encoder. A prompt seen before generates in
about the 2s the diffusion actually takes; a new one pays the ~155s once. The
encoder is also loaded, used and DROPPED before the diffusion loop — on a 24 GB
machine, holding it through generation is the difference between running and
swapping.

RUNNING ON METAL IS GATED, NOT ASSUMED. tests/ardy_mps_gate.py checks that the
float64->float32 cast MPS forces is harmless (it is: bit-identical output), that
Metal tracks CPU at a short horizon (0.96 mm worst joint disagreement over 4s),
and that long clips stay physically plausible on both devices. That gate is the
reason this worker defaults to MPS.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _glbanim import write_animated_glb  # noqa: E402
from _humanoid import BONE_NAMES  # noqa: E402
from _progress import artifact, progress, stage_done  # noqa: E402

STAGE = "motion"

DEFAULT_MODEL = "core"
#: Prompt -> LLM2Vec embedding. Lives beside the weights rather than in the job
#: output dir: it is worth keeping across jobs, and it is derived data that can
#: be deleted at any time with no worse consequence than one slow generation.
CACHE_DIR = Path.home() / ".cache" / "pi-desktop" / "gen3d" / "ardy-text"

# Longest clip worth generating in one call. ARDY is autoregressive, so cost is
# linear in duration and there is no quality cliff — this is a guard against a
# prompt asking for ten minutes, not a limit of the model.
MAX_SECONDS = 60.0


def _cache_path(prompt: str, model_name: str) -> Path:
    """One file per (prompt, model). The model is in the key because different
    ARDY variants were trained against different embedding shapes."""
    digest = hashlib.sha256(f"{model_name}\0{prompt}".encode()).hexdigest()[:32]
    return CACHE_DIR / f"{digest}.npz"


def cached_embedding(prompt: str, model_name: str):
    """The prompt's embedding if it has been computed before, else None."""
    path = _cache_path(prompt, model_name)
    if not path.exists():
        return None
    try:
        with np.load(path) as data:
            return data["feat"], data["mask"]
    except Exception:  # noqa: BLE001
        # A truncated cache file (killed mid-write, full disk) must cost one
        # slow encode, not the whole job.
        return None


def store_embedding(prompt: str, model_name: str, feat, mask) -> None:
    path = _cache_path(prompt, model_name)
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # Write-then-rename: a reader must never see a half-written embedding.
        # np.savez APPENDS ".npz" to a path argument — passing `<hash>.partial`
        # wrote `<hash>.partial.npz` and the rename below then failed with a
        # FileNotFoundError this very handler swallowed, so every run re-encoded
        # while looking like it had cached. A file OBJECT gets written verbatim.
        tmp = path.with_name(f"{path.name}.partial")
        with open(tmp, "wb") as fh:
            np.savez(fh, feat=feat, mask=mask)
        tmp.replace(path)
    except OSError:
        # Caching is an optimisation. A read-only or full disk is not a failure.
        pass


def cast_f64_buffers(model) -> list[str]:
    """float64 -> float32 in place, returning what was cast.

    MPS has no float64 at all — `.to("mps")` raises rather than downcasting —
    and ARDY carries one float64 buffer, the skeleton's rest pose. The gate
    measures what this costs: nothing, bit for bit.
    """
    import torch

    cast = []
    for name, buf in list(model.named_buffers()):
        if buf.dtype != torch.float64:
            continue
        owner = model
        *path, leaf = name.split(".")
        for part in path:
            owner = getattr(owner, part)
        setattr(owner, leaf, buf.float())
        cast.append(name)
    return cast


def to_device(model, device: str):
    """Move ARDY, including the device it *thinks* it is on.

    `self.device` is a plain attribute assigned at construction and nn.Module's
    `.to()` knows nothing about it, so a moved model keeps allocating its
    internal masks on the old device and dies mid-generation with "found at
    least two devices".
    """
    model = model.to(device)
    model.device = device
    for sub in model.modules():
        if getattr(sub, "device", None) is not None and sub is not model:
            try:
                sub.device = device
            except AttributeError:
                # A read-only `device` property already follows its parameters.
                pass
    return model


def pick_device(requested: str) -> str:
    import torch

    if requested != "auto":
        return requested
    return "mps" if torch.backends.mps.is_available() else "cpu"


def run(args: argparse.Namespace, out_dir: Path) -> None:
    import torch

    from ardy.model import load_model
    from ardy.model.registry import resolve_model_name
    from ardy.motion_rep.tools import length_to_mask
    from ardy.postprocess import post_process_motion
    from ardy.tools import seed_everything, to_numpy

    seconds = max(0.5, min(float(args.seconds), MAX_SECONDS))
    device = pick_device(args.device)
    name = resolve_model_name(args.model)

    # The model is loaded on CPU even when the target is MPS: load_model moves
    # it in its constructor, and the float64 rest pose has to be cast before any
    # such move can succeed.
    #
    # The text encoder is skipped ENTIRELY on a cache hit — `text_encoder=False`
    # rather than loading 16 GB and then not using it.
    cached = None if args.no_cache else cached_embedding(args.prompt, name)
    progress(STAGE, "Loading the motion model…")
    model = load_model(
        name,
        device="cpu",
        text_encoder=False if cached is not None else None,
        text_encoder_fp32=True,
    )
    fps = model.motion_rep.fps
    num_frames = int(seconds * fps)
    steps = args.steps or int(model.diffusion.num_base_steps)

    if cached is not None:
        feat_np, mask_np = cached
        text_feat = torch.from_numpy(feat_np).float()
        text_pad_mask = torch.from_numpy(mask_np)
        progress(STAGE, "Recognised this prompt — skipping the text encoder")
    else:
        progress(STAGE, "Reading the prompt (first time for this wording, ~2 min)…")
        t_text = time.time()
        with torch.no_grad():
            text_feat, text_pad_mask = model._encode_text([args.prompt])
        text_feat = text_feat.float()
        store_embedding(
            args.prompt, name, text_feat.cpu().numpy(), text_pad_mask.cpu().numpy()
        )
        # 16 GB released before the loop that needs the memory.
        model.text_encoder = None
        gc.collect()
        progress(STAGE, f"Understood the prompt in {time.time() - t_text:.1f}s")

    # One embedding, repeated per requested sample: the prompt is the same, only
    # the noise differs.
    if text_feat.shape[0] != args.samples:
        text_feat = text_feat[:1].repeat(args.samples, *([1] * (text_feat.dim() - 1)))
        text_pad_mask = text_pad_mask[:1].repeat(args.samples, *([1] * (text_pad_mask.dim() - 1)))

    cast_f64_buffers(model)
    model = to_device(model, device)

    progress(STAGE, f"Generating {seconds:.1f}s of motion ({num_frames} frames at {fps}fps)…")
    if args.seed is not None:
        seed_everything(args.seed)
    lengths = torch.tensor([num_frames] * args.samples, device=device)
    t0 = time.time()
    with torch.no_grad():
        motion = model(
            [args.prompt] * args.samples,
            num_frames,
            num_denoising_steps=steps,
            pad_mask=length_to_mask(lengths),
            first_heading_angle=torch.zeros(args.samples, device=device),
            motion_mask=None,
            observed_motion=None,
            text_feat=text_feat.to(device),
            text_pad_mask=text_pad_mask.to(device),
            cfg_weight=args.cfg_weight,
            progress_bar=lambda x, **k: x,
        )
        output = model.motion_rep.inverse(motion, is_normalized=True)
    took = time.time() - t0

    # Foot-contact cleanup. Without it the figure skates: the model predicts
    # contacts, and this is what actually pins the planted foot to the floor.
    corrected = post_process_motion(
        output["local_rot_mats"],
        output["root_positions"],
        output["foot_contacts"],
        model.skeleton,
    )
    output.update(corrected)
    output = to_numpy(output)

    rest = np.asarray(model.skeleton.neutral_joints.detach().cpu(), dtype=np.float64)
    parents = [int(p) for p in model.skeleton.joint_parents]
    _assert_our_skeleton(model, parents)

    progress(STAGE, f"Generated in {took:.1f}s ({seconds / max(took, 1e-6):.1f}x real time)")

    for i in range(args.samples):
        suffix = "" if args.samples == 1 else f"_{i:02d}"
        glb = out_dir / f"motion{suffix}.glb"
        npz = out_dir / f"motion{suffix}.npz"
        write_animated_glb(
            str(glb),
            bone_names=BONE_NAMES,
            parents=parents,
            rest_world=rest,
            local_rot_mats=output["local_rot_mats"][i],
            root_positions=output["root_positions"][i],
            fps=fps,
            name=args.prompt[:48],
            extras={"prompt": args.prompt, "fps": float(fps), "skeleton": "ardy-cskel27"},
        )
        # The NPZ is the real data — rotations, contacts, joint positions — for
        # anything that wants the motion rather than a preview of it.
        np.savez(
            npz,
            **{k: v[i] for k, v in output.items() if isinstance(v, np.ndarray)},
            fps=np.asarray(fps),
            text=np.asarray(args.prompt),
        )
        artifact(STAGE, "model-glb", str(glb), f"Motion — {args.prompt[:40]}")

    stage_done(
        STAGE,
        json.dumps(
            {
                "seconds": seconds,
                "frames": num_frames,
                "fps": float(fps),
                "device": device,
                "generateSeconds": round(took, 2),
                "samples": args.samples,
            }
        ),
    )


def _assert_our_skeleton(model, parents: list[int]) -> None:
    """ARDY's skeleton must be the one _humanoid.py emits, or the GLB is a lie.

    Checked at runtime rather than trusted: the two definitions live in
    different repos and a silent reorder upstream would produce a file that
    loads fine and animates the wrong joints — elbows bending as knees, which
    is exactly the kind of wrong that gets shipped because it still renders.
    """
    names = list(model.skeleton.bone_order_names)
    if names != BONE_NAMES:
        raise RuntimeError(
            "ARDY's skeleton no longer matches this app's cskel27 "
            f"({len(names)} vs {len(BONE_NAMES)} joints; first difference at "
            f"{next((i for i, (a, b) in enumerate(zip(names, BONE_NAMES)) if a != b), 'order')})"
        )
    if len(parents) != len(BONE_NAMES):
        raise RuntimeError("ARDY's parent list does not match its own joint list")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--op", default="text2motion", choices=["text2motion"])
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--samples", type=int, default=1)
    ap.add_argument("--steps", type=int, default=None)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--cfg-weight", type=float, default=2.0)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--device", default="auto", choices=["auto", "mps", "cpu"])
    ap.add_argument(
        "--no-cache",
        action="store_true",
        help="Re-encode the prompt even if its embedding is cached.",
    )
    args = ap.parse_args()

    if not args.prompt.strip():
        raise SystemExit("--prompt is required")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    run(args, out_dir)


if __name__ == "__main__":
    main()
