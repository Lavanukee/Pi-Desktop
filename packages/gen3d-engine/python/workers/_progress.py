"""Worker-side progress protocol: NDJSON on stdout (see engine/jobs.py) and a
tqdm shim that turns ANY library's tqdm loops into per-step progress events —
the TRELLIS.2 samplers, CubePart's denoiser and huggingface loaders all use
tqdm, so patching it (BEFORE the libraries are imported) yields real step
counts without forking any upstream code.
"""

from __future__ import annotations

import json
import sys


def emit(**fields) -> None:
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def progress(stage: str, message: str, step: int | None = None, total: int | None = None) -> None:
    fields: dict = {"event": "progress", "stage": stage, "message": message}
    if step is not None:
        fields["step"] = int(step)
    if total is not None:
        fields["totalSteps"] = int(total)
    emit(**fields)


def artifact(stage: str, kind: str, path: str, label: str) -> None:
    emit(event="artifact", stage=stage, kind=kind, path=path, label=label)


def stage_done(stage: str, message: str = "") -> None:
    emit(event="stage-done", stage=stage, message=message)


def error(message: str) -> None:
    emit(event="error", message=message)


class _StageRouter:
    """Maps tqdm desc strings to (stage, human message); mutable so a worker
    can flip the default stage as its pipeline advances."""

    def __init__(self) -> None:
        self.default_stage = "geometry"
        self.desc_map: dict[str, tuple[str, str]] = {}

    def resolve(self, desc: str) -> tuple[str, str]:
        for needle, mapped in self.desc_map.items():
            if needle.lower() in (desc or "").lower():
                return mapped
        return self.default_stage, desc or "Working…"


ROUTER = _StageRouter()


def patch_tqdm() -> None:
    """Replace tqdm.tqdm with a shim that forwards .update() to progress().
    Must run before any `from tqdm import tqdm` in library code."""
    import time

    import tqdm as tqdm_module

    real_tqdm = tqdm_module.tqdm
    last_emit = [0.0]

    class EmittingTqdm(real_tqdm):  # type: ignore[misc,valid-type]
        def update(self, n: int = 1):  # noqa: ANN001
            result = super().update(n)
            try:
                total = int(self.total) if self.total else None
                stage, message = ROUTER.resolve(self.desc or "")
                if total is not None and total > 1:
                    # Rate-limit: fast loops (e.g. "Loading weights", 415 items)
                    # would flood the event stream; always emit the final tick.
                    now = time.monotonic()
                    if int(self.n) >= total or now - last_emit[0] >= 0.25:
                        last_emit[0] = now
                        progress(stage, f"{message} ({int(self.n)}/{total})", int(self.n), total)
            except Exception:  # noqa: BLE001 — progress must never break the run
                pass
            return result

    tqdm_module.tqdm = EmittingTqdm
    try:
        import tqdm.auto as tqdm_auto

        tqdm_auto.tqdm = EmittingTqdm
    except ImportError:
        pass
