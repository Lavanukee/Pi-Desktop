"""The generate path builds its worker args WITHOUT running any model.

This exists because of a bug that reached jedd: `faceBudget` was read in
`start_generate` and used in `_run_generate`, which is a different method
reached across a thread boundary with positional args. It typechecked, it
imported, it passed all 767 TS tests, and it died at runtime with
`name 'face_budget' is not defined` — after the pipeline had loaded, so the
first sign of it was a failed generation rather than a failed start.

Nothing in the vitest suite can see a Python scope error and the workers had no
tests of their own, so the arg-building is exercised here directly: stub the
worker spawn, run every generate shape, and assert on what WOULD have been
spawned. Milliseconds, no weights.

Run: python tests/run.py   (from packages/gen3d-engine/python)
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))

from engine.jobs import JobManager  # noqa: E402


class _Stop(Exception):
    """Raised by the stubbed spawn to end the run at the first worker."""


class _Job:
    job_id = "test"
    plan = ["geometry", "texture"]
    stage = "geometry"

    def __init__(self) -> None:
        self.cancelled = MagicMock()
        self.cancelled.is_set.return_value = False


def _manager() -> tuple[JobManager, list[list[str]]]:
    """A JobManager whose spawns are stubs; returns it plus the captured argv."""
    calls: list[list[str]] = []
    m = JobManager.__new__(JobManager)  # bypass __init__: no cache dir, no threads
    m.registry = MagicMock()
    m.registry.pipeline_type.return_value = "512"
    m.registry.geometry_python.return_value = Path("/nonexistent/python")
    m.registry.geometry_tool_dir.return_value = Path("/nonexistent")
    m._publish = MagicMock()
    m._job_dir = MagicMock(return_value=Path("/tmp/pi-gen3d-test"))
    # kind='text' runs an image hop first; stub it so the text shape exercises
    # _run_generate's own scope without needing mflux.
    m._image_worker = MagicMock(
        return_value=(Path("/nonexistent/python"), Path("image.py"), ["--stub"])
    )

    def capture(job, venv, script, args, **kw):
        calls.append(list(args))
        raise _Stop()

    m._run_worker = capture
    return m, calls


def _spawned(**kw) -> list[str]:
    """Run one generate and return the argv of the first worker it spawns."""
    m, calls = _manager()
    args: dict = {
        "job": _Job(),
        "kind": "image",
        "prompt": "",
        "image_paths": ["/tmp/in.png"],
        "resolution": "low",
        "texture": True,
    }
    args.update(kw)
    try:
        m._run_generate(**args)
    except _Stop:
        pass
    assert calls, f"no worker was spawned for {kw}"
    return calls[0]


def test_face_budget_reaches_the_worker() -> None:
    """THE REGRESSION: a UI face limit must arrive as --bake-faces."""
    argv = _spawned(face_budget=30_000)
    assert "--bake-faces" in argv, argv
    assert argv[argv.index("--bake-faces") + 1] == "30000", argv


def test_adaptive_sends_no_cap() -> None:
    """0 is Adaptive — the worker picks its own, so the flag must be absent."""
    assert "--bake-faces" not in _spawned(face_budget=0)


def test_every_generate_shape_builds() -> None:
    """Each shape reaches a spawn. A Python scope error fails right here."""
    for kw in (
        {},
        {"texture": False},
        {"texture_size": 4096},
        {"face_budget": 99_000, "texture_size": 2048},
        {"kind": "text", "prompt": "a jeep", "image_paths": []},
    ):
        _spawned(**kw)  # raises on a NameError, asserts if nothing spawned
