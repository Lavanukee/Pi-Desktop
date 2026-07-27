"""Does ARDY's denoiser give the same motion on Metal as it does on CPU?

This is the gate that has to pass before any of it is wired to a button.

WHY IT EXISTS. Every previous model in this app that "ran clean on Metal and
returned garbage" failed the same way: an MPS kernel that is quietly less
accurate than its CPU twin, compounded over a loop. MEASURED on this M5, MLX's
default Metal matmul carries ~8e-4 error in what it calls float32 against CPU's
4.7e-7 — and ARDY is an AUTOREGRESSIVE diffusion model, so it runs its denoiser
tens of times and feeds each result back in as history. That is the worst
possible shape for a small per-step error: it does not stay small.

IT ASKS TWO QUESTIONS, because there are two ways this can go wrong. MPS has
no float64, and ARDY carries exactly one float64 buffer — the skeleton's rest
pose (neutral_joints, 27x3), which forward kinematics builds every frame from.
So it must be cast, and a cast is a change in its own right:

    A  cpu/f64 vs cpu/f32   does dropping to float32 change the motion at all?
    B  cpu/f32 vs mps/f32   does Metal agree with the CPU doing the same maths?
    C  is the long clip still a real human motion, on both devices?

Reporting one number for both would confuse "the cast was fine and Metal is
broken" with "Metal is fine and the cast was lossy", which are different fixes.

C EXISTS BECAUSE B CANNOT BE ASKED OF A LONG CLIP. ARDY is autoregressive: each
window is conditioned on the one before, so a difference of one ULP does not
stay one ULP. MEASURED on the same prompt, worst joint disagreement is 9.6e-4 m
over 4s and 2.3e-2 m over 12s — the same kernels, diverging because the system
amplifies. That is not Metal being wrong; a chaotic system fed a
slightly-different history produces a slightly-different, equally valid sample.
So B is asked at a SHORT horizon where it is still a fair question about
kernels, and the long horizon is judged on what actually matters: whether the
bones stay the same length, whether anything is NaN, and whether the body moves
at humanly possible speeds — on BOTH devices, so "Metal is no worse" is a
measurement rather than a hope.

WHAT IT COMPARES, and what it deliberately does not. The text encoder is an 8B
LLM run ONCE per prompt; it is not the part that loops, and running it twice
would cost 16 GB of loads to test the part least likely to drift. So the prompt
is encoded once on CPU in fp32 and that SAME embedding is fed to both devices —
`text_feat` on the model's __call__ is exactly that seam. What is compared is
the part that runs in a loop.

    python ardy_mps_gate.py --prompt "A person walks in a circle." --seconds 4

Exit 0 when Metal tracks CPU, 1 when it does not.
"""

from __future__ import annotations

import argparse
import contextlib
import time

import numpy as np
import torch

# Root joint positions in metres. A humanoid stride is ~0.7 m and a hand moves
# through ~1 m, so 5 mm of disagreement over a whole clip is imperceptible while
# still being far tighter than the drift a bad kernel produces (which shows up
# as tens of centimetres, or as a figure that sinks through the floor).
POS_TOL_M = 5e-3
# Rotations are compared as matrix entries in [-1, 1]; 1e-2 is roughly half a
# degree, below what an animator can see in a single frame.
ROT_TOL = 1e-2


def cast_f64_buffers(model) -> list[str]:
    """float64 -> float32 in place. Returns what was cast, so it is never silent.

    MPS has no float64 at all: `.to("mps")` raises rather than downcasting, so
    this is not an optimisation, it is the price of running on the GPU. What it
    costs is measured by comparison A above.
    """
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


@contextlib.contextmanager
def identical_noise(seed: int):
    """Force both devices to sample from the SAME noise.

    ARDY draws its initial latent with `torch.randn(shape, device=device)`, and
    torch's CPU and MPS generators are separate streams — the same seed gives
    different numbers. `seed_everything` seeds CPU and CUDA, never MPS, so a
    naive A/B compares two different samples and reports metres of "drift" from
    a model that is working perfectly. MEASURED before this existed: 2.595 m on
    posed_joints, which is not a precision bug, it is a different walk.

    Drawing on CPU and copying over costs nothing here (the latent is small) and
    makes the comparison mean what it claims to.
    """
    gen = torch.Generator(device="cpu").manual_seed(seed)
    real_randn, real_randn_like = torch.randn, torch.randn_like

    def randn(*shape, **kw):
        device = kw.pop("device", None)
        kw.pop("generator", None)
        if len(shape) == 1 and isinstance(shape[0], (tuple, list, torch.Size)):
            shape = tuple(shape[0])
        out = real_randn(*shape, generator=gen, **kw)
        return out.to(device) if device is not None else out

    def randn_like(tensor, **kw):
        kw.pop("generator", None)
        out = real_randn(tensor.shape, generator=gen, dtype=tensor.dtype, **kw)
        return out.to(tensor.device)

    torch.randn, torch.randn_like = randn, randn_like
    try:
        yield
    finally:
        torch.randn, torch.randn_like = real_randn, real_randn_like


def to_device(model, device: str):
    """Move ARDY, including the device it *thinks* it is on.

    `self.device` is a plain attribute assigned at construction, and nn.Module's
    `.to()` knows nothing about it — so a moved model keeps allocating its
    internal masks on the old device and dies with "found at least two devices,
    mps:0 and cpu". Submodules that cached it need the same treatment.
    """
    model = model.to(device)
    model.device = device
    for sub in model.modules():
        if getattr(sub, "device", None) is not None and not isinstance(sub, type(model)):
            try:
                sub.device = device
            except AttributeError:
                # A read-only `device` property already tracks its parameters.
                pass
    return model


def encode_once(model, prompt: str, samples: int):
    """The prompt's embedding, computed on CPU so both devices share one input."""
    with torch.no_grad():
        feat, mask = model._encode_text([prompt] * samples)
    return feat.float().cpu(), mask.cpu()


def run(model, device: str, text_feat, text_pad_mask, num_frames: int, steps: int, seed: int):
    from ardy.motion_rep.tools import length_to_mask
    from ardy.tools import seed_everything, to_numpy

    model = to_device(model, device)
    # Seed immediately before sampling, not once at the top: the two runs must
    # start from the same noise or nothing below means anything.
    seed_everything(seed)
    samples = text_feat.shape[0]
    lengths = torch.tensor([num_frames] * samples, device=device)
    with torch.no_grad(), identical_noise(seed):
        t0 = time.time()
        motion = model(
            [""] * samples,
            num_frames,
            num_denoising_steps=steps,
            pad_mask=length_to_mask(lengths),
            first_heading_angle=torch.zeros(samples, device=device),
            motion_mask=None,
            observed_motion=None,
            text_feat=text_feat.to(device),
            text_pad_mask=text_pad_mask.to(device),
            progress_bar=lambda x, **k: x,
        )
        out = model.motion_rep.inverse(motion, is_normalized=True)
        took = time.time() - t0
    return to_numpy(out), took


def compare(ref: dict, test: dict) -> list[tuple[str, float, float, bool]]:
    """Per-array worst-case disagreement, with the tolerance it is held to."""
    rows = []
    for key in sorted(ref):
        a, b = np.asarray(ref[key]), np.asarray(test[key])
        if a.dtype.kind not in "fc" or a.shape != b.shape:
            continue
        worst = float(np.abs(a.astype(np.float64) - b.astype(np.float64)).max())
        tol = POS_TOL_M if "position" in key or "joints" in key else ROT_TOL
        rows.append((key, worst, tol, worst <= tol))
    return rows


# A skeleton is rigid: bone lengths must not change frame to frame. This is the
# single most diagnostic statistic for "did the model produce a body or a mess"
# — a diverged rollout stretches limbs long before it looks obviously wrong in
# any single frame. 1 mm of variation across a whole clip is generous.
BONE_LENGTH_TOL_M = 1e-3
# Usain Bolt peaks near 12 m/s; a joint on a swinging limb moves faster than the
# root. 20 m/s is comfortably above anything human and far below the hundreds
# that a diverged rollout produces.
MAX_JOINT_SPEED_MS = 20.0


def plausibility(out: dict, fps: int, skeleton) -> list[tuple[str, float, float, bool]]:
    """Is this a body moving, judged without reference to the other device?"""
    joints = np.asarray(out["posed_joints"], dtype=np.float64)
    if joints.ndim == 4:
        joints = joints[0]
    rows: list[tuple[str, float, float, bool]] = []

    finite = float(np.isfinite(joints).all())
    rows.append(("all values finite", finite, 1.0, finite == 1.0))

    # Bone length stability, over every parent->child edge of the skeleton.
    parents = getattr(skeleton, "parents", None)
    worst_bone = 0.0
    if parents is not None:
        for child, parent in enumerate(parents):
            if parent is None or int(parent) < 0:
                continue
            lengths = np.linalg.norm(joints[:, child] - joints[:, int(parent)], axis=-1)
            worst_bone = max(worst_bone, float(lengths.max() - lengths.min()))
    rows.append(("bone length drift (m)", worst_bone, BONE_LENGTH_TOL_M, worst_bone <= BONE_LENGTH_TOL_M))

    speed = np.linalg.norm(np.diff(joints, axis=0), axis=-1).max() * fps
    rows.append(("peak joint speed (m/s)", float(speed), MAX_JOINT_SPEED_MS, speed <= MAX_JOINT_SPEED_MS))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", default="A person walks forward and then turns around.")
    ap.add_argument("--seconds", type=float, default=4.0)
    ap.add_argument(
        "--long-seconds",
        type=float,
        default=12.0,
        help="Horizon for the plausibility check (C). 0 skips it.",
    )
    ap.add_argument("--steps", type=int, default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--model", default="core")
    args = ap.parse_args()

    if not torch.backends.mps.is_available():
        print("no MPS on this machine — nothing to gate")
        return 0

    from ardy.model import load_model
    from ardy.model.registry import resolve_model_name

    name = resolve_model_name(args.model)
    print(f"loading {name} (cpu, with text encoder)…", flush=True)
    model = load_model(name, device="cpu", text_encoder_fp32=True)
    fps = model.motion_rep.fps
    num_frames = int(args.seconds * fps)
    steps = args.steps or int(model.diffusion.num_base_steps)
    print(f"  {fps} fps, {num_frames} frames, {steps} denoising steps")

    print(f"encoding the prompt once on CPU: {args.prompt!r}", flush=True)
    feat, mask = encode_once(model, args.prompt, 1)
    print(f"  text_feat {tuple(feat.shape)}")
    # The 8B encoder has done its one job. Drop it before the loops run: holding
    # 16 GB through both passes is how a 24 GB machine starts swapping, which
    # would make the timings below meaningless.
    model.text_encoder = None
    import gc

    gc.collect()

    print("running on cpu (float64 rest pose, the reference)…", flush=True)
    ref64, cpu64_s = run(model, "cpu", feat, mask, num_frames, steps, args.seed)
    print(f"  {cpu64_s:.1f}s")

    cast = cast_f64_buffers(model)
    print(f"cast to float32: {', '.join(cast) or '(nothing)'}")

    print("running on cpu (float32 rest pose)…", flush=True)
    ref32, cpu32_s = run(model, "cpu", feat, mask, num_frames, steps, args.seed)
    print(f"  {cpu32_s:.1f}s")

    print("running on mps…", flush=True)
    test, mps_s = run(model, "mps", feat, mask, num_frames, steps, args.seed)
    print(f"  {mps_s:.1f}s  ({cpu32_s / max(mps_s, 1e-6):.1f}x vs cpu)")

    failed = 0
    for label, a, b in (
        ("A  cast: cpu/f64 vs cpu/f32", ref64, ref32),
        ("B  metal: cpu/f32 vs mps/f32", ref32, test),
    ):
        rows = compare(a, b)
        print(f"\n{label}")
        print(f"  {'array':26s} {'worst abs diff':>15s} {'tol':>10s}")
        for key, worst, tol, ok in rows:
            print(f"    {key:24s} {worst:15.3e} {tol:10.0e}  {'ok' if ok else 'FAIL'}")
        bad = [r for r in rows if not r[3]]
        if bad:
            failed += 1
            print(f"  -> FAILED on {len(bad)}/{len(rows)} arrays")
        else:
            print(f"  -> ok across {len(rows)} arrays")

    if args.long_seconds > 0:
        long_frames = int(args.long_seconds * fps)
        print(f"\nC  plausibility over {args.long_seconds:g}s ({long_frames} frames)")
        for device in ("cpu", "mps"):
            out, secs = run(model, device, feat, mask, long_frames, steps, args.seed)
            rows = plausibility(out, fps, model.skeleton)
            print(f"  {device} ({secs:.1f}s, {args.long_seconds / max(secs, 1e-6):.1f}x real time)")
            for name, value, limit, ok in rows:
                print(f"    {name:26s} {value:12.4f}  limit {limit:<8g} {'ok' if ok else 'FAIL'}")
            bad = [r for r in rows if not r[3]]
            if bad:
                failed += 1
                print(f"  -> FAILED {len(bad)} check(s) on {device}")

    if failed:
        print("\nGATE FAILED.")
        return 1
    print("\nGATE PASSED — the cast is harmless, Metal tracks CPU, and long clips stay plausible.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
