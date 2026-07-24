"""AutoRemesher worker — quad retopology via the official 1.0.0 arm64 CLI.

Runs inside the tiny meshtools venv (trimesh) purely for GLB↔OBJ conversion;
the remeshing itself is the native binary (`--input/--output/--target-quads`),
which we verified headless on this machine (cube → 78 quads in 0.017 s).
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _progress import artifact, error, progress, stage_done  # noqa: E402

STAGE = "retopo"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mesh", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--cli", required=True)
    ap.add_argument("--target-quads", type=int, default=20_000)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    mesh_path = Path(args.mesh)

    import trimesh

    progress(STAGE, "Converting mesh to OBJ…", 1, 4)
    loaded = trimesh.load(str(mesh_path), force="mesh")
    in_obj = out_dir / "retopo-input.obj"
    loaded.export(str(in_obj))

    out_obj = out_dir / "retopo-output.obj"
    report = out_dir / "retopo-report.txt"
    progress(STAGE, f"Remeshing to ~{args.target_quads:,} quads…", 2, 4)
    result = subprocess.run(
        [
            args.cli,
            "--input", str(in_obj),
            "--output", str(out_obj),
            "--target-quads", str(args.target_quads),
            "--report", str(report),
        ],
        capture_output=True,
        text=True,
        timeout=3600,
    )
    if result.returncode != 0 or not out_obj.exists():
        error(f"autoremesher failed ({result.returncode}): {result.stderr.strip()[-500:]}")
        sys.exit(1)

    progress(STAGE, "Converting result to GLB…", 3, 4)
    remeshed = trimesh.load(str(out_obj), force="mesh")
    out_glb = out_dir / "retopo.glb"
    remeshed.export(str(out_glb))
    stats = report.read_text() if report.exists() else ""
    quads_line = next((ln.strip() for ln in stats.splitlines() if "Quads:" in ln), "")
    artifact(STAGE, "model-glb", str(out_glb), "Retopologized (quads)")
    progress(STAGE, f"Retopology done. {quads_line}", 4, 4)
    stage_done(STAGE, quads_line or "Retopology done")


if __name__ == "__main__":
    main()
