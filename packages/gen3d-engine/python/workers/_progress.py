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


def preview(stage: str, data_uri: str, step: int, total: int, width: int, height: int) -> None:
    """One INTERMEDIATE frame of a still-running stage — a look at the work, not
    a result.

    Deliberately a data URI rather than a path, and deliberately a separate
    event from `artifact`: an artifact is a real output that gets registered,
    opened, handed to the next stage and (for the chat's image tools) written
    into the tool result the model reads. A preview is none of those things. It
    exists for the few seconds the job runs, is thrown away when the job ends,
    and must never reach the model's context or the session transcript. Keeping
    it off disk is what makes that guarantee cheap to hold: there is no file for
    anything downstream to find.

    Sized for that role — see mlx_image_worker's PREVIEW_MAX_PX: a 256px JPEG
    frame MEASURED at 12-17 KB (~23 KB base64), against 1.4-2.1 MB for the
    full-resolution PNG of the same step.
    """
    emit(
        event="preview",
        stage=stage,
        dataUri=data_uri,
        step=int(step),
        totalSteps=int(total),
        width=int(width),
        height=int(height),
    )


def stage_done(stage: str, message: str = "") -> None:
    emit(event="stage-done", stage=stage, message=message)


def error(message: str) -> None:
    emit(event="error", message=message)


class _StageRouter:
    """Maps tqdm desc strings to (stage, human message, span); mutable so a
    worker can flip the default stage as its pipeline advances.

    `span` is where that loop sits INSIDE its stage, as (lo, hi) fractions. One
    stage is often several back-to-back tqdm loops — TRELLIS runs three 12-step
    samplers before it exports anything — and reporting each one as its own
    0→100%% made the bar rewind twice per generation. Declaring the spans lets
    the shim rescale every loop into one monotonic climb across the stage.
    """

    def __init__(self) -> None:
        self.default_stage = "geometry"
        self.desc_map: dict[str, tuple[str, str] | tuple[str, str, tuple[float, float]]] = {}
        # Shown when a tqdm loop carries no recognisable description. "Working…"
        # is true but says nothing, and some of these loops run for twenty
        # minutes — long enough that the user deserves to know what for.
        self.fallback_message = "Working…"

    def resolve(self, desc: str) -> tuple[str, str, tuple[float, float]]:
        for needle, mapped in self.desc_map.items():
            if needle.lower() in (desc or "").lower():
                if len(mapped) == 3:
                    return mapped  # type: ignore[return-value]
                return mapped[0], mapped[1], (0.0, 1.0)
        return self.default_stage, desc or self.fallback_message, (0.0, 1.0)


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
                stage, message, (lo, hi) = ROUTER.resolve(self.desc or "")
                if total is not None and total > 1:
                    # Rate-limit: fast loops (e.g. "Loading weights", 415 items)
                    # would flood the event stream; always emit the final tick.
                    now = time.monotonic()
                    if int(self.n) >= total or now - last_emit[0] >= 0.25:
                        last_emit[0] = now
                        # The step counter shown stays this loop's own (n/total
                        # is what the user can verify); the reported position is
                        # rescaled into the stage so the bar only ever climbs.
                        pos = lo + (int(self.n) / total) * (hi - lo)
                        progress(
                            stage,
                            f"{message} ({int(self.n)}/{total})",
                            round(pos * 1000),
                            1000,
                        )
            except Exception:  # noqa: BLE001 — progress must never break the run
                pass
            return result

    tqdm_module.tqdm = EmittingTqdm
    try:
        import tqdm.auto as tqdm_auto

        tqdm_auto.tqdm = EmittingTqdm
    except ImportError:
        pass
