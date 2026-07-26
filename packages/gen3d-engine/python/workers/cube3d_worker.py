"""Cube3D worker — text → 3D directly, with no image in the middle.

WHY THIS EXISTS ALONGSIDE TRELLIS

TRELLIS is an IMAGE→3D model, so text→3D goes text → Mage-Flow image → TRELLIS
mesh. That middle hop costs a step and, more importantly, throws away everything
the prompt said that the image did not happen to show. Cube3D (Roblox, in the
same checkout as CubePart) is natively text→shape: an autoregressive shape
transformer, `engine.t2s([prompt])`, no image anywhere.

MEASURED on this M5 Pro, "a wooden chair" at resolution_base 8.0:
load 34.5s, generate 77.7s → 70,970 verts / 141,980 faces, and the render is a
clean slatted chair with four legs and stretchers — noticeably tidier topology
than TRELLIS, which arrives with thousands of stray fragments.

It runs on MPS with no patching at all: upstream's own `select_device()` already
prefers mps over cpu. That is a pleasant exception on this machine — see
cubepart_worker for the opposite case.

WHAT IT DOES NOT DO

No texture. Cube3D emits geometry only, so the studio's Texture stage cannot
re-bake it either: that stage samples the voxel colour field TRELLIS saves, and
there is no equivalent here. A Cube3D asset is a clay model unless it is
textured by some other route. Said plainly rather than discovered later.

`--parts` chains CubePart on the result, which is the "text → segmented parts,
no image middleman" path end to end.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _progress import ROUTER, artifact, emit, patch_tqdm, progress, stage_done  # noqa: E402

STAGE = "geometry"

patch_tqdm()
ROUTER.default_stage = STAGE
# Cube3D's sampling loop is labelled "generating"; give it the whole geometry
# band so the bar climbs once from 0 to 100 rather than restarting per phase.
ROUTER.desc_map = {"generating": (STAGE, "Generating shape from your prompt", (0.0, 1.0))}


def snapshot(repo: str) -> Path:
    from huggingface_hub import snapshot_download

    return Path(snapshot_download(repo, local_files_only=True))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--cube-dir", required=True)
    # Upstream's own default. Higher gives a denser marching-cubes grid at a
    # roughly cubic memory cost, so this is the shape-detail dial.
    ap.add_argument("--resolution-base", type=float, default=8.0)
    ap.add_argument("--top-p", type=float, default=None)
    # Optional part schema: when given, CubePart runs on the generated mesh, so
    # one job goes prompt → mesh → named parts with no image step anywhere.
    ap.add_argument("--parts", default="")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(Path.home() / ".cache" / "pi-desktop" / "gen3d" / "hf"))

    progress(STAGE, "Loading Cube3D…", 1, 10)
    t0 = time.time()
    weights = snapshot("Roblox/cube3d-v0.5")
    sys.path.insert(0, str(Path(args.cube_dir)))
    import trimesh
    from cube3d.inference.engine import Engine
    from cube3d.inference.utils import select_device

    device = select_device()
    engine = Engine(
        str(Path(args.cube_dir) / "cube3d" / "configs" / "open_model_v0.5.yaml"),
        str(weights / "shape_gpt.safetensors"),
        str(weights / "shape_tokenizer.safetensors"),
        device=device,
    )
    progress(STAGE, f"Cube3D ready in {time.time() - t0:.0f}s ({device})", 2, 10)

    t1 = time.time()
    mesh_v_f = engine.t2s(
        [args.prompt],
        use_kv_cache=True,
        resolution_base=args.resolution_base,
        top_p=args.top_p,
    )
    verts, faces = mesh_v_f[0][0], mesh_v_f[0][1]
    if verts is None or len(verts) == 0:
        msg = "Cube3D produced no geometry for that prompt"
        emit(event="error", message=msg)
        sys.exit(2)

    geo_path = out_dir / "geometry.glb"
    trimesh.Trimesh(verts, faces).export(str(geo_path))
    artifact(STAGE, "model-glb", str(geo_path), "Generated shape")
    stage_done(
        STAGE,
        f"Shape generated in {time.time() - t1:.0f}s — "
        f"{len(verts):,} vertices / {len(faces):,} triangles",
    )

    parts = [p.strip() for p in args.parts.split(",") if p.strip()]
    if not parts:
        return

    # Hand off to CubePart in its own process: it loads ~19 GB of weights, and
    # Cube3D's own 8.3 GB must be out of RAM first (the 24 GB invariant this
    # whole engine is built around).
    del engine
    ROUTER.default_stage = "segment"
    progress("segment", f"Splitting into {len(parts)} parts…", 1, 10)
    worker = Path(__file__).resolve().parent / "cubepart_worker.py"
    proc = subprocess.run(
        [
            sys.executable, str(worker),
            "--mesh", str(geo_path),
            "--out-dir", str(out_dir),
            "--cube-dir", args.cube_dir,
            "--parts", ",".join(parts),
        ],
        cwd=args.cube_dir,
        capture_output=False,
    )
    if proc.returncode != 0:
        emit(event="error", message="the shape was generated but splitting it into parts failed")
        sys.exit(2)


if __name__ == "__main__":
    main()
