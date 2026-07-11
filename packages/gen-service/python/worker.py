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

Phase 1 backend = mflux (MLX FLUX.2 / Z-Image on Apple Silicon). We DRIVE the
mflux console command (the stable public interface) rather than its churning
Python API, and read per-step progress from `--stepwise-image-output-dir` (mflux
writes `seed_<seed>_step<N>of<M>.png` + a running `seed_<seed>_composite.png` as
each denoising step completes) — an authoritative signal that needs no tqdm
parsing. The worker stays modality-pluggable: audio/video/3d dispatch lands here
later behind the same envelope + event stream.
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
    \\r, so we split on both \\r and \\n."""
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


def main():
    try:
        job = json.loads(sys.stdin.read())
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "jobId": "?", "message": f"bad job envelope: {e}"})
        return 1

    job_id = job.get("id", "?")
    modality = job.get("modality")
    try:
        if modality == "image":
            return run_image(job)
        emit(
            {
                "event": "error",
                "jobId": job_id,
                "message": f"unsupported modality '{modality}' (phase 1 = image only)",
                "recoverable": False,
            }
        )
        return 1
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "jobId": job_id, "message": str(e), "recoverable": False})
        return 1


if __name__ == "__main__":
    sys.exit(main())
