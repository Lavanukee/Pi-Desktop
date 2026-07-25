"""AutoRemesher worker — quad retopology via the official 1.0.0 arm64 CLI.

Runs inside the tiny meshtools venv (trimesh) for mesh preparation and GLB↔OBJ
conversion; the remeshing itself is the native binary
(`--input/--output/--target-quads/--edge-scaling/--adaptivity/--sharp-edge`).

The input mesh is WELDED before it reaches the binary — see _meshprep for why
(a GLB's UV-split vertices read as thousands of boundary edges and AutoRemesher
returns a mesh full of holes). The result keeps its real quad topology:
`retopo-quads.obj` is the quad mesh, and `retopo.glb` carries the quad face and
edge data in `meshes[].extras.pd_topology` because glTF itself can only store
triangles.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _meshprep import (  # noqa: E402
    count_nonmanifold_edges,
    decimate_to,
    export_geometry_obj,
    heal_for_native_tool,
    load_concatenated,
)
from _progress import artifact, error, progress, stage_done  # noqa: E402

STAGE = "retopo"
TOTAL_STEPS = 6

# Beyond this the wireframe payload costs more than it is worth; the viewer
# falls back to the triangle wireframe and the counts are still reported.
MAX_WIRE_EDGES = 60_000


def read_polygons(obj_path: Path) -> list[list[int]]:
    """Parse OBJ faces as polygons (AutoRemesher writes plain `f a b c d`)."""
    polys: list[list[int]] = []
    for line in obj_path.read_text().splitlines():
        if not line.startswith("f "):
            continue
        idx: list[int] = []
        for token in line.split()[1:]:
            head = token.split("/")[0]
            if head:
                idx.append(int(head) - 1)
        if len(idx) >= 3:
            polys.append(idx)
    return polys


def polygon_edges(polys: list[list[int]]) -> list[int]:
    """Unique undirected polygon-boundary edges, flat [a,b,a,b,…].

    These are the edges a quad wireframe should draw — triangulating for glTF
    adds diagonals that are not real topology.
    """
    seen: set[tuple[int, int]] = set()
    flat: list[int] = []
    for poly in polys:
        n = len(poly)
        for i in range(n):
            a, b = poly[i], poly[(i + 1) % n]
            key = (a, b) if a < b else (b, a)
            if key in seen:
                continue
            seen.add(key)
            flat.append(key[0])
            flat.append(key[1])
    return flat


# AutoRemesher narrates every solver step on stderr. Dumping that at the user
# as an "error" is noise, not a reason — keep only lines that aren't progress.
PROGRESS_NOISE = (
    "searching boundaries",
    "check_that multiplicity",
    "new ls iteration",
    "extract connections",
    "extract edges",
    "extract mesh",
    "in opennl",
    "iter",
)


def drop_small_components(mesh, min_fraction: float, say):
    """Drop connected components below `min_fraction` of the mesh's faces.

    Quadric decimation is per-component: a big reduction ratio tears a single
    surface into thousands of islands, and every island becomes its own
    parametrisation problem for AutoRemesher. Proportional (not absolute) because
    the meaningful scale is "share of this model", and returns the mesh untouched
    on any failure — cleanup must never break a retopo.
    """
    if min_fraction <= 0:
        return mesh
    try:
        parts = mesh.split(only_watertight=False)
    except Exception:  # noqa: BLE001
        return mesh
    if len(parts) <= 1:
        return mesh
    import trimesh as _tm

    total = max(1, len(mesh.faces))
    keep = [p for p in parts if len(p.faces) >= total * min_fraction]
    if not keep:
        keep = [max(parts, key=lambda p: len(p.faces))]
    if len(keep) == len(parts):
        return mesh
    merged = _tm.util.concatenate(keep)
    say(
        f"Dropped {len(parts) - len(keep):,} fragments created by decimation "
        f"({len(parts):,} → {len(keep):,} components)"
    )
    return merged


def run_remesher(cmd: list[str], timeout_s: int) -> subprocess.CompletedProcess:
    """Run AutoRemesher so it can NEVER outlive this worker.

    OBSERVED live: an AutoRemesher left over from a killed run was still burning
    99% of a core **two hours later**, reparented to init (ppid=1) with nowhere
    to send its output. `subprocess.run(timeout=…)` cannot prevent that — the
    timeout only fires while THIS process is alive, so if the worker is killed
    (app quit, crash, cancel-by-signal) the child is simply orphaned. macOS has
    no PDEATHSIG, so we supervise explicitly: own process group, poll for both
    the timeout and for our parent disappearing, and kill the whole group on the
    way out. A remesh that no one is waiting for is pure waste.
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,  # own group, so killpg reaps its TBB threads too
    )

    def reap() -> None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            proc.kill()

    deadline = time.time() + timeout_s
    while True:
        try:
            out, err = proc.communicate(timeout=2)
            return subprocess.CompletedProcess(cmd, proc.returncode, out, err)
        except subprocess.TimeoutExpired:
            pass
        # Our parent died (jobs.py went away) → nobody will ever read this.
        if os.getppid() == 1:
            reap()
            return subprocess.CompletedProcess(cmd, 1, "", "parent exited; remesh abandoned")
        if time.time() > deadline:
            reap()
            return subprocess.CompletedProcess(
                cmd, 1, "", f"remesh exceeded {timeout_s}s and was stopped"
            )


def failure_reason(result: subprocess.CompletedProcess | None) -> str:
    """A short, human reason for a failed remesh — never a wall of solver logs."""
    if result is None:
        return "the remesher did not run"
    lines = [
        ln.strip()
        for ln in ((result.stderr or "") + "\n" + (result.stdout or "")).splitlines()
        if ln.strip() and not any(n in ln.lower() for n in PROGRESS_NOISE)
    ]
    if lines:
        return f"exit {result.returncode}: {lines[-1][:200]}"
    return (
        f"it exited {result.returncode} partway through solving, twice. This usually means the "
        "surface is too tangled to parametrise — try segmenting it first, or lower the target "
        "quad count."
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mesh", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--cli", required=True)
    ap.add_argument("--target-quads", type=int, default=20_000)
    ap.add_argument("--adaptivity", type=float, default=1.0)
    ap.add_argument("--edge-scaling", type=float, default=1.0)
    ap.add_argument("--sharp-edge", type=float, default=90.0)
    ap.add_argument("--max-input-faces", type=int, default=40_000)
    # A remesh that has run this long is not going to finish usefully; the old
    # 3600s cap meant an hour of 99% CPU before anyone found out.
    ap.add_argument("--timeout", type=int, default=600)
    # Components below this share of the faces are decimation debris.
    ap.add_argument("--min-component-fraction", type=float, default=0.001)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    import trimesh

    progress(STAGE, "Reading mesh…", 1, TOTAL_STEPS)
    source = load_concatenated(args.mesh)

    progress(STAGE, "Welding + healing the surface…", 2, TOTAL_STEPS)
    prep_lines: list[str] = []
    healed, prep = heal_for_native_tool(source, prep_lines.append)
    for line in prep_lines:
        progress(STAGE, line, 2, TOTAL_STEPS)
    if prep.out_faces == 0:
        error("the input mesh has no usable faces after cleanup")
        sys.exit(1)
    if prep.boundary_after > 0:
        progress(
            STAGE,
            f"{prep.boundary_after:,} boundary edges remain (open surface) — remeshing anyway",
            2,
            TOTAL_STEPS,
        )

    healed = decimate_to(
        healed, args.max_input_faces, lambda m: progress(STAGE, m, 2, TOTAL_STEPS)
    )
    # Clean up AFTER decimating, not just before. MEASURED on a clean TRELLIS
    # mesh (a single connected component!): decimating 1,067,132 → 40,000 faces
    # SHATTERED it into 2,440 components, and AutoRemesher then parametrises
    # every one — the reason a retopo jedd expected to take ~2 minutes was still
    # running after 12. Dropping components under 0.1% of the faces takes that
    # 2,440 → 10 while retaining 87.6% of the surface. The pre-decimation heal
    # cannot do this: the fragments do not exist yet when it runs.
    healed = drop_small_components(
        healed, args.min_component_fraction, lambda m: progress(STAGE, m, 2, TOTAL_STEPS)
    )

    in_obj = out_dir / "retopo-input.obj"
    export_geometry_obj(healed, str(in_obj))

    out_obj = out_dir / "retopo-quads.obj"
    report = out_dir / "retopo-report.txt"
    cmd = [
        args.cli,
        "--input", str(in_obj),
        "--output", str(out_obj),
        "--target-quads", str(args.target_quads),
        "--adaptivity", str(args.adaptivity),
        "--edge-scaling", str(args.edge_scaling),
        "--sharp-edge", str(args.sharp_edge),
        "--report", str(report),
    ]
    # AutoRemesher's parametrisation is TBB-parallel and OBSERVED to fail
    # nondeterministically: two runs over a byte-identical input, one exited 1
    # partway through the LS iterations, the next succeeded. A single retry
    # turns that flake into a non-event instead of a dead-end error.
    progress(STAGE, f"Remeshing to ~{args.target_quads:,} quads…", 3, TOTAL_STEPS)
    result = None
    for attempt in (1, 2):
        result = run_remesher(cmd, args.timeout)
        if result.returncode == 0 and out_obj.exists():
            break
        if attempt == 1:
            progress(STAGE, "Remesher stopped early — retrying…", 3, TOTAL_STEPS)
    if result is None or result.returncode != 0 or not out_obj.exists():
        error(f"AutoRemesher could not remesh this mesh — {failure_reason(result)}")
        sys.exit(1)

    progress(STAGE, "Measuring topology…", 4, TOTAL_STEPS)
    polys = read_polygons(out_obj)
    arity = Counter(len(p) for p in polys)
    quads = arity.get(4, 0)
    tris = arity.get(3, 0)
    ngons = sum(c for n, c in arity.items() if n > 4)
    total_polys = len(polys)
    if total_polys == 0:
        error("autoremesher produced an empty mesh")
        sys.exit(1)

    progress(STAGE, "Converting result to GLB…", 5, TOTAL_STEPS)
    remeshed = trimesh.load(str(out_obj), force="mesh", process=False)
    open_edges = count_nonmanifold_edges(remeshed)
    from _meshprep import count_boundary_edges  # local: keeps the import list tidy

    holes = count_boundary_edges(remeshed)

    wire = polygon_edges(polys)
    topology = {
        "kind": "quad" if quads > tris + ngons else "mixed",
        "quads": quads,
        "tris": tris,
        "ngons": ngons,
        "polygons": total_polys,
        "vertices": int(len(remeshed.vertices)),
        "triangles": int(len(remeshed.faces)),
        "boundaryEdges": holes,
        "nonManifoldEdges": open_edges,
        "watertight": bool(holes == 0),
        "source": "autoremesher",
        "prep": prep.as_dict(),
    }
    if len(wire) // 2 <= MAX_WIRE_EDGES:
        topology["wireEdges"] = wire
    remeshed.metadata["pd_topology"] = topology

    out_glb = out_dir / "retopo.glb"
    # WITH normals. AutoRemesher's OBJ carries none, and a GLB with POSITION as
    # its only attribute renders BLACK under any standard PBR material — the
    # viewer has nothing to light. (The viewer also computes them defensively.)
    remeshed.export(str(out_glb), include_normals=True)
    (out_dir / "retopo-topology.json").write_text(json.dumps(topology_summary(topology), indent=2))

    quad_pct = round(100 * quads / total_polys)
    artifact(STAGE, "model-glb", str(out_glb), f"Retopologized · {quads:,} quads")
    artifact(STAGE, "model-obj", str(out_obj), "Quad mesh (OBJ)")
    summary = (
        f"{quads:,} quads ({quad_pct}% quad), {tris:,} tris"
        + (f", {ngons:,} n-gons" if ngons else "")
        + (", watertight" if holes == 0 else f", {holes:,} open edges")
    )
    progress(STAGE, f"Retopology done — {summary}", TOTAL_STEPS, TOTAL_STEPS)
    stage_done(STAGE, summary)


def topology_summary(topology: dict) -> dict:
    """The on-disk topology record, without the bulky wireframe payload."""
    return {k: v for k, v in topology.items() if k != "wireEdges"}


if __name__ == "__main__":
    main()
