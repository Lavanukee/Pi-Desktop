"""Segmentation must account for itself while it is extracting.

The worst moment in the studio was a 13-minute CubePart run whose readout sat on
"Deciding which surface belongs to which part (30/30) · 12m 36s" for over five
of those minutes. The denoise is a tqdm loop and reports; the mesh extraction
that follows it is inside the same pipeline call and reported nothing at all, so
the last denoise tick was the last thing the user ever saw.

`install_extraction_progress` wraps the two seams the pipeline already goes
through. This drives those wrappers with fakes — no torch, no weights, no
25-minute run — and asserts the emissions, because the failure mode is silence
and silence is exactly what a smoke test cannot see.

Run: python tests/run.py   (from packages/gen3d-engine/python)
"""

from __future__ import annotations

import importlib
import io
import json
import sys
import types
from contextlib import redirect_stdout
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE / "workers"))


def _load_worker():
    """Import cubepart_worker on a bare interpreter.

    Importing it runs patch_tqdm() at module scope, which needs a `tqdm` module
    with a subclassable `tqdm`. The provisioned cube venv has one; a plain
    python3 running the test suite does not, so stand one up. Nothing here
    touches torch/trimesh — those are imported inside main().
    """
    if "tqdm" not in sys.modules:
        stub = types.ModuleType("tqdm")

        class _Tqdm:  # minimal: patch_tqdm only subclasses it
            def __init__(self, *a, **kw) -> None:
                self.total = None
                self.n = 0
                self.desc = ""

            def update(self, n: int = 1) -> None:
                self.n += n

        stub.tqdm = _Tqdm
        auto = types.ModuleType("tqdm.auto")
        auto.tqdm = _Tqdm
        stub.auto = auto
        sys.modules["tqdm"] = stub
        sys.modules["tqdm.auto"] = auto
    return importlib.import_module("cubepart_worker")


class _FakePipe:
    """Stands in for PartShapeDenoiserPipeline: the one seam that matters is
    that `input_to_part_shape` reaches the extraction via self.decode_shape."""

    def __init__(self) -> None:
        self.decoded = 0

    def decode_shape(self, *_a, **_kw):
        self.decoded += 1
        return "meshes"

    def input_to_part_shape(self, *_a, **_kw):
        # Verbatim shape of the real call: the extraction is reached through
        # self.decode_shape, which is why an instance attribute can hook it.
        return self.decode_shape()


class _FakeEvaluator:
    """ImplicitFieldCoarseToFineEvaluator's contract: evaluate() calls the fine
    callback once per batch element, in order."""

    def __init__(self, batch: int) -> None:
        self.batch = batch

    def evaluate(self, eval_func_coarse, eval_func_fine, *_a, **_kw):
        eval_func_coarse("coarse-positions")
        for i in range(self.batch):
            eval_func_fine("fine-positions", i)
        return "grids"


def _run(parts, *, with_evaluator=True):
    """Install the hooks, drive one extraction, return the emitted events."""
    worker = _load_worker()
    pipe = _FakePipe()
    evaluator_cls = type("Eval", (_FakeEvaluator,), {}) if with_evaluator else None
    buf = io.StringIO()
    with redirect_stdout(buf):
        worker.install_extraction_progress(pipe, parts, evaluator_cls)
        pipe.input_to_part_shape()
        if evaluator_cls is not None:
            evaluator_cls(len(parts)).evaluate(lambda _p: None, lambda _p, _i: None)
    events = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
    return events, pipe


def test_extraction_announces_itself_before_it_starts() -> None:
    """The moment the denoise ends, the readout stops being about the denoise."""
    events, pipe = _run(["main body", "top part", "bottom part"])
    assert pipe.decoded == 1, "the wrapper must still call through to the real decode"
    messages = [e["message"] for e in events if e.get("event") == "progress"]
    assert messages, "the extraction emitted nothing at all"
    assert messages[0].startswith("Building part meshes"), messages[0]
    assert all(e["stage"] == "segment" for e in events)


def test_every_part_is_reported_by_name() -> None:
    """One event per part, naming it — the extraction is per-part, so say so."""
    parts = ["main body", "top part", "bottom part", "left part", "right part"]
    events, _ = _run(parts)
    messages = [e["message"] for e in events if e.get("event") == "progress"]
    for i, name in enumerate(parts):
        wanted = f"Building part meshes — {name} ({i + 1}/{len(parts)})"
        assert wanted in messages, f"missing per-part progress: {wanted!r} in {messages}"
    assert any(m.startswith("Extracting surfaces from") for m in messages), messages


def test_no_stale_step_counter_survives_into_the_extraction() -> None:
    """The bug was a LIE, not an absence: "(30/30)" while nothing was at 30/30.

    Nothing emitted from the extraction may carry a denoise step counter, and
    nothing may claim a percentage the worker cannot measure.
    """
    events, _ = _run(["main body", "top part"])
    for e in events:
        assert "(30/30)" not in e.get("message", ""), e
        # `step`/`totalSteps` are the denoise's; the extraction has no honest
        # denominator, so it must not invent one.
        assert "step" not in e, f"extraction progress invented a step count: {e}"
        assert "totalSteps" not in e, f"extraction progress invented a total: {e}"


def test_phase_label_survives_a_missing_evaluator() -> None:
    """Upstream can move the evaluator; the run must not lose its voice."""
    events, pipe = _run(["main body", "top part"], with_evaluator=False)
    messages = [e["message"] for e in events if e.get("event") == "progress"]
    assert pipe.decoded == 1
    assert any(m.startswith("Building part meshes") for m in messages), messages
