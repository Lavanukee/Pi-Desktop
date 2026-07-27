"""The STAGE path builds its worker args WITHOUT running any model.

Sibling of test_generate_args.py, and it exists for the same reason one level
along: `start_stage` reads the request and `_run_stage` uses it, and those are
different methods reached across a `threading.Thread` boundary with positional
args. Nothing connects them but the key list `start_stage` filters the body
through — so a field can be correct in the TypeScript contract, correct in the
IPC payload, correct in the HTTP body, and still never reach the worker.

THE BUG THIS GUARDS: `sourcePath` was absent from that list. Texturing a mesh
that had been retopologised therefore never received `--voxels`, the worker
looked for `voxels.npz` beside the retopo output where it has no reason to be,
and it told the user the model "was imported" — about a mesh TRELLIS had just
generated. Nothing typechecked wrong; nothing crashed; the stage simply failed
with a false explanation.

Run: python tests/run.py   (from packages/gen3d-engine/python)
"""

from __future__ import annotations

import inspect
import re
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import MagicMock

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))

from engine.jobs import STAGE_OPTION_KEYS, JobManager  # noqa: E402


def _fixture() -> tuple[Path, Path]:
    """A generation dir (mesh + voxels) and a retopo dir (mesh only).

    This is the real shape on disk: `voxels.npz` is written by the generation
    and stays there, while every downstream stage gets its own job dir.
    """
    root = Path(tempfile.mkdtemp(prefix="pi-stage-args-"))
    gen = root / "generation"
    retopo = root / "retopo"
    gen.mkdir()
    retopo.mkdir()
    (gen / "geometry.glb").write_bytes(b"glb")
    (gen / "voxels.npz").write_bytes(b"npz")
    (retopo / "retopo.glb").write_bytes(b"glb")
    return gen / "geometry.glb", retopo / "retopo.glb"


def _manager():
    """A JobManager with every path stubbed — no cache dir, no threads, no venvs."""
    m = JobManager.__new__(JobManager)  # bypass __init__: no cache dir, no threads
    m.registry = MagicMock()
    m.registry.is_installed.return_value = True
    m.registry.has_skintokens.return_value = False
    m.registry.geometry_python.return_value = Path("/nonexistent/python")
    m.registry.geometry_tool_dir.return_value = Path("/nonexistent")
    m.registry.meshtools_python.return_value = Path("/nonexistent/python")
    m.registry.venv_python.return_value = Path("/nonexistent/python")
    m.registry.tool_dir.return_value = Path("/nonexistent")
    m.registry.autoremesher_cli.return_value = Path("/nonexistent/autoremesher")
    m.registry.quadriflow_cli.return_value = Path("/nonexistent/quadriflow")
    m._publish = MagicMock()
    m._job_dir = MagicMock(return_value=Path("/tmp/pi-gen3d-test"))
    m._lock = threading.Lock()
    m._jobs = {}

    def new_job(plan):
        job = MagicMock()
        job.job_id = "test"
        job.plan = plan
        job.cancelled.is_set.return_value = False
        return job

    m._new_job = new_job
    return m


def _staged(body: dict) -> list[str]:
    """Push one request through start_stage; return the worker argv it builds.

    Deliberately goes through `start_stage` rather than calling `_run_stage`
    directly — the whole defect is the handover between them, and a test that
    hands `_run_stage` a ready-made options dict cannot see it.
    """
    calls: list[list[str]] = []
    spawned = threading.Event()

    m = _manager()

    def capture(job, venv, script, args, **kw):
        calls.append(list(args))
        spawned.set()

    m._run_worker = capture

    res = m.start_stage(body)
    assert res.get("ok") is True, res
    assert spawned.wait(10), f"no worker was spawned for {body}"
    return calls[0]


def test_source_path_reaches_the_worker_as_voxels() -> None:
    """THE REGRESSION: texturing a retopo result must be pointed at the
    generation's colour volume."""
    gen_mesh, retopo_mesh = _fixture()
    argv = _staged(
        {"op": "texture", "modelPath": str(retopo_mesh), "sourcePath": str(gen_mesh)}
    )
    assert "--voxels" in argv, (
        "sourcePath was dropped between start_stage and _run_stage — the worker "
        f"gets no colours and blames the user for importing the model: {argv}"
    )
    assert argv[argv.index("--voxels") + 1] == str(gen_mesh.parent / "voxels.npz"), argv


def test_texture_on_the_generations_own_mesh_still_finds_its_voxels() -> None:
    """The path that always worked: colours sit beside the mesh, no sourcePath."""
    gen_mesh, _ = _fixture()
    argv = _staged({"op": "texture", "modelPath": str(gen_mesh)})
    assert argv[argv.index("--voxels") + 1] == str(gen_mesh.parent / "voxels.npz"), argv


def test_no_voxels_anywhere_sends_no_flag() -> None:
    """A genuinely colourless mesh: the flag is absent and the worker decides."""
    _, retopo_mesh = _fixture()
    assert "--voxels" not in _staged({"op": "texture", "modelPath": str(retopo_mesh)})


def test_retopo_knobs_reach_the_worker() -> None:
    """The keys that already worked must keep working."""
    _, mesh = _fixture()
    argv = _staged(
        {"op": "retopo", "modelPath": str(mesh), "targetQuads": 20_000, "adaptivity": 0.5}
    )
    assert argv[argv.index("--target-quads") + 1] == "20000", argv
    assert argv[argv.index("--adaptivity") + 1] == "0.5", argv


def test_rig_probe_only_reaches_the_worker() -> None:
    _, mesh = _fixture()
    assert "--probe-only" in _staged(
        {"op": "rig", "modelPath": str(mesh), "probeOnly": True}
    )


def test_every_stage_op_builds() -> None:
    """Each op reaches a spawn. A Python scope error fails right here."""
    _, mesh = _fixture()
    for op in ("segment", "retopo", "rig", "texture"):
        _staged({"op": op, "modelPath": str(mesh)})
    # Motion is the one op that REQUIRES a prompt — start_stage rejects it
    # without one, so it cannot be built like the others.
    _staged({"op": "motion", "modelPath": str(mesh), "prompt": "a person waves"})


def test_option_allowlist_covers_everything_run_stage_reads() -> None:
    """THE CLASS OF BUG, not just this instance.

    `sourcePath` was read by `_run_stage` and never forwarded by `start_stage`,
    and nothing in the codebase related the two. Compare them directly, so the
    next option added to `_run_stage` cannot be silently dropped the same way.
    """
    read = set(
        re.findall(r"""options\.get\(\s*["'](\w+)["']""", inspect.getsource(JobManager._run_stage))
    )
    missing = sorted(read - set(STAGE_OPTION_KEYS))
    assert not missing, (
        f"_run_stage reads {missing} but start_stage does not forward them — "
        "add them to STAGE_OPTION_KEYS or they are silently always None"
    )


def test_motion_carries_the_prompt_the_length_and_the_rigged_mesh() -> None:
    """All three are the whole request, and `seconds` travels the allowlist.

    The prompt IS the input (every other stage acts on the mesh alone), the
    length is a real cost dial, and `--mesh` is what makes the clip land in the
    user's own rigged character instead of a bare skeleton.
    """
    _, mesh = _fixture()
    argv = _staged(
        {"op": "motion", "modelPath": str(mesh), "prompt": "a person waves", "seconds": 12}
    )
    assert "--prompt" in argv and argv[argv.index("--prompt") + 1] == "a person waves"
    assert "--seconds" in argv and float(argv[argv.index("--seconds") + 1]) == 12.0
    assert "--mesh" in argv and argv[argv.index("--mesh") + 1] == str(mesh)


def test_motion_without_a_prompt_is_refused() -> None:
    """A blank description would generate something arbitrary and call it the
    user's. Refusing is the honest answer, and it must happen before a job
    exists rather than as a worker crash."""
    _, mesh = _fixture()
    m = _manager()
    res = m.start_stage({"op": "motion", "modelPath": str(mesh)})
    assert res["ok"] is False
    assert "movement" in res["error"]
