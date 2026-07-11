#!/usr/bin/env python3
"""
Pi Desktop generation worker — the NDJSON-emitting backend behind the Node
GenServiceClient.

Contract (kept dead-simple + language-agnostic so the SAME worker runs locally
under `uv run` and, later, on a remote GPU host whose stdout is tunnelled back):

  stdin  : one JSON job envelope (see @pi-desktop/gen-service protocol.ts / GenJob)
  stdout : newline-delimited JSON GenEvents:
             {"event":"start","jobId","total","candidates"}
             {"event":"download","jobId","ratio?","detail?"}
             {"event":"progress","jobId","candidate","step","total","previewPath?"}
             {"event":"candidate","jobId","index","output":{...GenOutput}}
             {"event":"done","jobId","outputs":[...]}
             {"event":"error","jobId","message","recoverable?"}
             {"event":"log","jobId","text"}                (advisory)

The worker is modality-pluggable; `main()` dispatches on the envelope's
`modality`:

  image  -> run_image  : mflux (MLX FLUX.2 / Z-Image on Apple Silicon). We DRIVE
                         the mflux console command (the stable public interface),
                         reading per-step progress from `--stepwise-image-output-dir`.
  audio  -> run_audio  : mlx-audio TTS (Qwen3-TTS default, Kokoro, Voxtral). We
                         drive `python -m mlx_audio.tts.generate` in THIS uv env
                         (base pkg injected by worker-command's baseWorkerWith).
  3d     -> run_3d      : TripoSR one-shot (image->geometry). TRELLIS.2 (~15GB) is
                         too heavy to reload per asset, so it runs in a PERSISTENT
                         `--serve` stdin-loop that loads the pipeline ONCE (see
                         serve_loop). run_3d is shared by both paths.
  video  -> (not here)  : LTX routes to the ComfyUI adapter; motion-graphics to the
                         Node/ffmpeg hyperframes path. Neither is uv-worker driven.

Every modality emits the SAME start->progress->candidate->done|error sequence, so
the Node client (protocol.ts / client.ts) is fully modality-agnostic.

Backend-package facts learned by real smoke [measured 2026-07-10, M-series]:
  * mlx-audio 0.4.5 CLI: `python -m mlx_audio.tts.generate --model <repo> --text
    <str> --audio_format <fmt> --file_prefix <p> --output_path <dir>` writes
    `<dir>/<p>_000.<fmt>` (zero-padded 3-digit index suffix).
  * Kokoro (prince-canuma/Kokoro-82M) additionally needs the optional G2P extra
    `misaki[en]` (worker-command extraWith / catalog auxDeps) — without it the
    KokoroPipeline import fails. spaCy `en_core_web_sm` is auto-fetched at run.
"""

import glob
import json
import os
import re
import subprocess
import sys
import threading
import time

_STDOUT_LOCK = threading.Lock()

# jobId stamped on serve-loop lifecycle events (readiness / control), distinct
# from any real job id so a persistent-worker adapter can filter them.
SERVE_JOB_ID = "<serve>"


def emit(obj):
    """Write one NDJSON event to stdout atomically."""
    line = json.dumps(obj, separators=(",", ":"))
    with _STDOUT_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


_STEP_RE = re.compile(r"seed_(-?\d+)_step(\d+)of(\d+)\.png$")
_RATIO_RE = re.compile(r"(\d+)\s*/\s*(\d+)")


def latest_step(step_dir, total):
    """Return (preview_path, one_based_step) for the furthest step written, or
    (None, None). Prefers the running composite as the preview image."""
    best = None
    for path in glob.glob(os.path.join(step_dir, "seed_*_step*of*.png")):
        m = _STEP_RE.search(path)
        if m is None:
            continue
        n = int(m.group(2))  # 0-indexed step
        if best is None or n > best:
            best = n
    if best is None:
        return (None, None)
    composite = glob.glob(os.path.join(step_dir, "seed_*_composite.png"))
    preview = composite[0] if composite else None
    return (preview, min(best + 1, total))


def build_mflux_cmd(spec, seed, out_path, step_dir):
    """Build the mflux console argv for one seed. `mfluxCommand` is the DEDICATED
    console script (z-image / flux2 / qwen each need their own — the unified
    `mflux-generate` only drives FLUX)."""
    cmd = [spec["mfluxCommand"]]
    if spec.get("mfluxModel"):
        cmd += ["--model", str(spec["mfluxModel"])]
    if spec.get("baseModel"):
        cmd += ["--base-model", str(spec["baseModel"])]
    if spec.get("quantize"):
        cmd += ["-q", str(spec["quantize"])]
    cmd += ["--prompt", str(spec["prompt"])]
    if spec.get("negativePrompt"):
        cmd += ["--negative-prompt", str(spec["negativePrompt"])]
    if spec.get("width"):
        cmd += ["--width", str(spec["width"])]
    if spec.get("height"):
        cmd += ["--height", str(spec["height"])]
    if spec.get("steps"):
        cmd += ["--steps", str(spec["steps"])]
    if spec.get("guidance") is not None:
        cmd += ["--guidance", str(spec["guidance"])]
    cmd += ["--seed", str(seed)]
    cmd += ["--stepwise-image-output-dir", step_dir]
    cmd += ["--output", out_path]
    return cmd


def watch_steps(job_id, cand_idx, step_dir, total, stop):
    """Poll the stepwise dir; emit a progress event each time a further step
    lands. Runs in its own thread so it is not throttled by pipe backpressure."""
    seen = -1
    while not stop.is_set():
        preview, step = latest_step(step_dir, total)
        if step is not None and step > seen:
            seen = step
            evt = {
                "event": "progress",
                "jobId": job_id,
                "candidate": cand_idx,
                "step": step,
                "total": total,
            }
            if preview is not None:
                evt["previewPath"] = preview
            emit(evt)
        time.sleep(0.25)


def drain_output(job_id, stream):
    """Drain the merged child output so tqdm never blocks on backpressure, and
    surface a coarse `download` event while weights are fetched. tqdm redraws with
    \\r, so we split on both \\r and \\n. Shared by every modality's subprocess."""
    buf = ""
    announced_download = False
    while True:
        chunk = stream.read(256)
        if chunk == "":
            break
        buf += chunk
        parts = re.split(r"[\r\n]", buf)
        buf = parts.pop()
        for line in parts:
            low = line.lower()
            if "fetching" in low or "downloading" in low:
                announced_download = True
                m = _RATIO_RE.search(line)
                ratio = None
                if m is not None:
                    done, tot = int(m.group(1)), int(m.group(2))
                    ratio = (done / tot) if tot else None
                emit(
                    {
                        "event": "download",
                        "jobId": job_id,
                        **({"ratio": ratio} if ratio is not None else {}),
                        "detail": line.strip()[:120],
                    }
                )
    if announced_download:
        emit({"event": "download", "jobId": job_id, "ratio": 1.0, "detail": "weights ready"})


def drive_subprocess(job_id, cmd, env=None):
    """Spawn a child, drain its merged stdout/stderr (emitting `download` events),
    wait, and return its exit code. The generic runner behind run_audio / run_3d;
    run_image has its own variant because it also runs a step-watcher thread."""
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    try:
        drain_output(job_id, proc.stdout)
    finally:
        proc.wait()
    return proc.returncode


# ---------------------------------------------------------------------------
# IMAGE (mflux / MLX) — phase-1, verified end-to-end on M5 Pro.
# ---------------------------------------------------------------------------


def run_one(job_id, spec, seed, cand_idx, out_dir, total_steps):
    step_dir = os.path.join(out_dir, f"steps_c{cand_idx}_s{seed}")
    os.makedirs(step_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"cand{cand_idx}_seed{seed}.png")
    cmd = build_mflux_cmd(spec, seed, out_path, step_dir)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    stop = threading.Event()
    watcher = threading.Thread(
        target=watch_steps, args=(job_id, cand_idx, step_dir, total_steps, stop), daemon=True
    )
    watcher.start()
    try:
        drain_output(job_id, proc.stdout)
    finally:
        proc.wait()
        stop.set()
        watcher.join(timeout=1.0)

    if proc.returncode != 0:
        raise RuntimeError(f"{spec['mfluxCommand']} exited with code {proc.returncode}")
    if not os.path.exists(out_path):
        raise RuntimeError(f"mflux produced no output at {out_path}")
    # Final full-resolution step is done — emit the terminal progress tick.
    emit(
        {
            "event": "progress",
            "jobId": job_id,
            "candidate": cand_idx,
            "step": total_steps,
            "total": total_steps,
            "previewPath": out_path,
        }
    )
    return out_path


def run_image(job):
    job_id = job["id"]
    spec = job.get("image")
    if not spec:
        emit({"event": "error", "jobId": job_id, "message": "image job missing `image` spec"})
        return 1
    seeds = list(spec.get("seeds") or [0])
    total_steps = int(spec.get("steps") or 8)
    out_dir = job["outputDir"]
    os.makedirs(out_dir, exist_ok=True)

    emit({"event": "start", "jobId": job_id, "total": total_steps, "candidates": len(seeds)})

    outputs = []
    for idx, seed in enumerate(seeds):
        out_path = run_one(job_id, spec, seed, idx, out_dir, total_steps)
        output = {
            "outputPath": out_path,
            "modality": "image",
            "model": spec.get("modelId", spec["mfluxCommand"]),
            "seed": seed,
        }
        if spec.get("width"):
            output["width"] = int(spec["width"])
        if spec.get("height"):
            output["height"] = int(spec["height"])
        outputs.append(output)
        emit({"event": "candidate", "jobId": job_id, "index": idx, "output": output})

    emit({"event": "done", "jobId": job_id, "outputs": outputs})
    return 0


# ---------------------------------------------------------------------------
# AUDIO · TTS (mlx-audio) — Qwen3-TTS (default) / Kokoro / Voxtral.
# Base uv --with is `mlx-audio` (worker-command baseWorkerWith('mlx-audio'));
# a model may add an extra (Kokoro -> `misaki[en]`) via catalog auxDeps.
#
# `job["audio"]` spec (resolved by the app; the worker stays catalog-free):
#   prompt        str    text to synthesize                        (REQUIRED)
#   modelId       str    catalog id — output FOOTNOTE stamp
#   mlxAudioModel str    HF repo id passed to --model              (REQUIRED)
#   voice         str?   --voice (e.g. af_heart / Chelsie)
#   speed         num?   --speed
#   lang          str?   --lang_code (e.g. "a" = American English)
#   steps         int?   --steps (model-specific diffusion steps)
#   audioFormat   str?   --audio_format (default "wav")
#   seeds         [int]? one per candidate (default [0]); the TTS CLI has no seed
#                        knob, so seeds drive candidate COUNT + the output stamp.
# ---------------------------------------------------------------------------


def build_audio_cmd(spec, prefix, out_dir, fmt):
    """Build the mlx-audio TTS argv. Driven via THIS interpreter's `-m` so it uses
    the uv env worker.py was launched in (which already has mlx-audio + any aux)."""
    model = spec.get("mlxAudioModel") or spec.get("model")
    if not model:
        raise RuntimeError("audio job missing `mlxAudioModel` (HF repo id)")
    if not spec.get("prompt"):
        raise RuntimeError("audio job missing `prompt` text")
    cmd = [
        sys.executable,
        "-m",
        "mlx_audio.tts.generate",
        "--model",
        str(model),
        "--text",
        str(spec["prompt"]),
        "--audio_format",
        fmt,
        "--file_prefix",
        prefix,
        "--output_path",
        out_dir,
    ]
    if spec.get("voice"):
        cmd += ["--voice", str(spec["voice"])]
    if spec.get("speed") is not None:
        cmd += ["--speed", str(spec["speed"])]
    if spec.get("lang"):
        cmd += ["--lang_code", str(spec["lang"])]
    if spec.get("steps"):
        cmd += ["--steps", str(spec["steps"])]
    return cmd


def find_audio_output(out_dir, prefix, fmt):
    """Locate the file mlx-audio wrote for `prefix`. It appends a zero-padded index
    (`<prefix>_000.<fmt>` [measured]); tolerate a bare `<prefix>.<fmt>` too."""
    matches = sorted(glob.glob(os.path.join(out_dir, f"{glob.escape(prefix)}*.{fmt}")))
    return matches[0] if matches else None


def synthesize_audio(job_id, spec, seed, cand_idx, out_dir):
    """Run one TTS render and return the produced audio path. A distinct
    per-candidate file_prefix keeps candidates from colliding on `_000`."""
    fmt = str(spec.get("audioFormat") or "wav")
    prefix = f"cand{cand_idx}_seed{seed}"
    cmd = build_audio_cmd(spec, prefix, out_dir, fmt)
    rc = drive_subprocess(job_id, cmd)
    if rc != 0:
        raise RuntimeError(f"mlx-audio TTS exited with code {rc}")
    out_path = find_audio_output(out_dir, prefix, fmt)
    if out_path is None:
        raise RuntimeError(f"mlx-audio produced no {fmt} output for prefix {prefix}")
    return out_path


def run_audio(job):
    job_id = job["id"]
    spec = job.get("audio")
    if not spec:
        emit({"event": "error", "jobId": job_id, "message": "audio job missing `audio` spec"})
        return 1
    if not spec.get("prompt"):
        emit({"event": "error", "jobId": job_id, "message": "audio job missing `prompt` text"})
        return 1
    seeds = list(spec.get("seeds") or [0])
    out_dir = job["outputDir"]
    os.makedirs(out_dir, exist_ok=True)

    # TTS has no denoising steps to preview; one synthesis pass == total 1.
    emit({"event": "start", "jobId": job_id, "total": 1, "candidates": len(seeds)})

    outputs = []
    for idx, seed in enumerate(seeds):
        out_path = synthesize_audio(job_id, spec, seed, idx, out_dir)
        emit(
            {
                "event": "progress",
                "jobId": job_id,
                "candidate": idx,
                "step": 1,
                "total": 1,
            }
        )
        output = {
            "outputPath": out_path,
            "modality": "audio",
            "model": spec.get("modelId") or spec.get("mlxAudioModel") or "mlx-audio",
            "seed": seed,
        }
        outputs.append(output)
        emit({"event": "candidate", "jobId": job_id, "index": idx, "output": output})

    emit({"event": "done", "jobId": job_id, "outputs": outputs})
    return 0


# ---------------------------------------------------------------------------
# 3D — TripoSR one-shot + TRELLIS.2 persistent worker.
#
# `job["threed"]` (a.k.a. `job["3d"]`) spec:
#   modelId       str    catalog id — output FOOTNOTE stamp
#   inputImage    str    path to the source image (image->3d)      (REQUIRED)
#   command       [str]? explicit argv template; tokens {input} {output} {seed}
#                        {resolution} are substituted. Lets the app drive the real
#                        TripoSR repo script without a code change [fwd].
#   resolution    int?   TRELLIS knob (512 / 1024 / 1536)
#   outputFormat  str?   "glb" (default) | "obj"
#   seeds         [int]? one per candidate (default [0])
#
# TripoSR is a one-shot (small weights). TRELLIS.2 loads ~15GB, so it MUST run in
# serve_loop (load once, many assets) — worker.py is otherwise process-per-job and
# would reload weights every call. The real TripoSR/trellis2 invocation + weights
# are a DEFERRED gate (§6 of the plan): build_3d_cmd returns the argv only when the
# app supplies `command`; otherwise synthesize_3d raises a clear "not yet wired".
# ---------------------------------------------------------------------------


def build_3d_cmd(spec, out_path, seed):
    """Resolve the 3D argv from an explicit `command` template, or None when no
    real invocation is wired yet (the deferred TripoSR/trellis2 gate)."""
    template = spec.get("command")
    if not template:
        return None
    tokens = {
        "input": str(spec.get("inputImage", "")),
        "output": out_path,
        "seed": str(seed),
        "resolution": str(spec.get("resolution", "")),
    }

    def sub(arg):
        out = str(arg)
        for k, v in tokens.items():
            out = out.replace("{" + k + "}", v)
        return out

    return [sub(a) for a in template]


def load_trellis_pipeline(spec=None):
    """Load the persistent TRELLIS.2 pipeline ONCE for serve mode. Scaffold: the
    real ~15GB `Trellis2ImageTo3DPipeline` instantiation is a deferred Phase-D gate
    (weights not downloaded in-agent), so this returns a handle the serve loop
    threads through to synthesize_3d. Kept as a seam so wiring the real load is a
    one-function change and the serve framing is testable without weights."""
    return {"loaded": False, "note": "trellis2 weights not downloaded (deferred gate)"}


def synthesize_3d(job_id, spec, seed, cand_idx, out_dir, pipeline=None):
    """Produce one 3D asset and return its path. One-shot (TripoSR) or via the
    persistent `pipeline` handle (TRELLIS.2). The real synthesis is deferred — this
    runs an explicit `command` template if the app supplies one, else raises."""
    fmt = str(spec.get("outputFormat") or "glb")
    out_path = os.path.join(out_dir, f"cand{cand_idx}_seed{seed}.{fmt}")
    cmd = build_3d_cmd(spec, out_path, seed)
    if cmd is None:
        raise RuntimeError(
            "3D synthesis not yet wired: real TripoSR / trellis2-mlx weights are a "
            "deferred gate (supply `command` in the 3d spec to drive a repo script)"
        )
    rc = drive_subprocess(job_id, cmd)
    if rc != 0:
        raise RuntimeError(f"3D generation exited with code {rc}")
    if not os.path.exists(out_path):
        raise RuntimeError(f"3D generation produced no output at {out_path}")
    return out_path


def run_3d(job, pipeline=None):
    job_id = job["id"]
    spec = job.get("threed") or job.get("3d")
    if not spec:
        emit({"event": "error", "jobId": job_id, "message": "3d job missing `threed` spec"})
        return 1
    seeds = list(spec.get("seeds") or [0])
    out_dir = job["outputDir"]
    os.makedirs(out_dir, exist_ok=True)

    emit({"event": "start", "jobId": job_id, "total": 1, "candidates": len(seeds)})

    outputs = []
    for idx, seed in enumerate(seeds):
        out_path = synthesize_3d(job_id, spec, seed, idx, out_dir, pipeline)
        emit(
            {
                "event": "progress",
                "jobId": job_id,
                "candidate": idx,
                "step": 1,
                "total": 1,
            }
        )
        output = {
            "outputPath": out_path,
            "modality": "3d",
            "model": spec.get("modelId") or "triposr",
            "seed": seed,
        }
        outputs.append(output)
        emit({"event": "candidate", "jobId": job_id, "index": idx, "output": output})

    emit({"event": "done", "jobId": job_id, "outputs": outputs})
    return 0


def serve_loop(stdin=None, load_pipeline=load_trellis_pipeline):
    """Persistent 3D worker (TRELLIS.2). Launched as `worker.py --serve`.

    Framing (the contract a Node persistent-worker adapter codes against):
      1. Load the ~15GB pipeline ONCE, then emit a READY `log` on stdout.
      2. Read ONE JSON job envelope per stdin line; run it through run_3d, which
         emits the normal start->progress->candidate->done sequence keyed by that
         envelope's `id`. The terminal `done` (or `error`) marks that job complete
         and the worker ready for the next line.
      3. A per-job failure emits `error` for that jobId but does NOT kill the loop
         — the expensive pipeline stays resident.
      4. A `{"type":"shutdown"}` line (or EOF) stops the loop cleanly.
    """
    stdin = sys.stdin if stdin is None else stdin
    try:
        pipeline = load_pipeline()
    except Exception as e:  # noqa: BLE001
        emit(
            {
                "event": "error",
                "jobId": SERVE_JOB_ID,
                "message": f"trellis pipeline load failed: {e}",
                "recoverable": False,
            }
        )
        return 1

    emit({"event": "log", "jobId": SERVE_JOB_ID, "text": "trellis serve ready"})

    for raw in stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:  # noqa: BLE001
            emit({"event": "error", "jobId": SERVE_JOB_ID, "message": f"bad job line: {e}"})
            continue
        if not isinstance(msg, dict):
            emit({"event": "error", "jobId": SERVE_JOB_ID, "message": "job line is not an object"})
            continue
        if msg.get("type") == "shutdown" or msg.get("op") == "shutdown":
            break
        job_id = msg.get("id", "?")
        try:
            run_3d(msg, pipeline=pipeline)
        except Exception as e:  # noqa: BLE001
            emit(
                {
                    "event": "error",
                    "jobId": job_id,
                    "message": str(e),
                    "recoverable": False,
                }
            )

    emit({"event": "log", "jobId": SERVE_JOB_ID, "text": "trellis serve stopped"})
    return 0


def dispatch(job):
    """Route one job envelope to its modality handler. Video is intentionally NOT
    here: LTX runs on the ComfyUI adapter and motion-graphics on the Node/ffmpeg
    hyperframes path — neither is uv-worker driven."""
    modality = job.get("modality")
    job_id = job.get("id", "?")
    if modality == "image":
        return run_image(job)
    if modality == "audio":
        return run_audio(job)
    if modality == "3d":
        return run_3d(job)
    if modality == "video":
        emit(
            {
                "event": "error",
                "jobId": job_id,
                "message": (
                    "video is not served by the uv worker — LTX routes to the ComfyUI "
                    "adapter, motion-graphics to the Node/ffmpeg hyperframes path"
                ),
                "recoverable": False,
            }
        )
        return 1
    emit(
        {
            "event": "error",
            "jobId": job_id,
            "message": f"unsupported modality '{modality}'",
            "recoverable": False,
        }
    )
    return 1


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if "--serve" in argv:
        return serve_loop()

    try:
        job = json.loads(sys.stdin.read())
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "jobId": "?", "message": f"bad job envelope: {e}"})
        return 1

    job_id = job.get("id", "?")
    try:
        return dispatch(job)
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "jobId": job_id, "message": str(e), "recoverable": False})
        return 1


if __name__ == "__main__":
    sys.exit(main())
