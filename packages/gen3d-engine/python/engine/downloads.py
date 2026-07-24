"""Download manager: weights via huggingface_hub in a CANCELLABLE subprocess,
progress from polling the hub cache's per-repo blob dirs (resume-safe: bytes
already on disk count immediately), then environment provisioning (envs.py).

Progress convention on the /events stream (contract Gen3dDownloadUpdate):
  {type:"download", id, receivedBytes, totalBytes, done, error?}
Weights fill 0..97% of totalBytes; the env-provision phase holds at 97% until
everything is verified (the contract carries no message field for downloads,
so the last 3% simply reads as "finishing up").
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import envs
from .bus import EventBus
from .registry import Registry

ENV_PHASE_FRACTION = 0.97


def repo_cache_dir(hf_home: Path, repo: str) -> Path:
    return hf_home / "hub" / ("models--" + repo.replace("/", "--"))


def bytes_on_disk(hf_home: Path, repo: str) -> int:
    """Blob bytes present for a repo (includes *.incomplete resume files)."""
    blobs = repo_cache_dir(hf_home, repo) / "blobs"
    total = 0
    if blobs.is_dir():
        for f in blobs.iterdir():
            try:
                total += f.stat().st_size
            except OSError:
                pass
    # xet-backed downloads stage under xet/ before materializing; blobs/ is
    # the stable signal and undercounts at worst (progress never regresses to
    # the UI because the manager keeps a monotonic max).
    return total


class DownloadTask:
    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.cancelled = threading.Event()
        self.proc: subprocess.Popen | None = None
        self.done = False


class DownloadManager:
    def __init__(self, registry: Registry, bus: EventBus) -> None:
        self.registry = registry
        self.bus = bus
        self._tasks: dict[str, DownloadTask] = {}
        self._lock = threading.Lock()

    def is_downloading(self, model_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(model_id)
            return task is not None and not task.done

    def cancel(self, model_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(model_id)
        if task is None or task.done:
            return False
        task.cancelled.set()
        proc = task.proc
        if proc is not None and proc.poll() is None:
            proc.terminate()
        return True

    def start(self, model_id: str) -> str | None:
        """Returns an error string, or None when the download thread started."""
        model = self.registry.model(model_id)
        if model is None:
            return f"unknown model: {model_id}"
        if self.is_downloading(model_id):
            return None  # already in flight — idempotent
        if self.registry.is_installed(model_id):
            return None
        task = DownloadTask(model_id)
        with self._lock:
            self._tasks[model_id] = task
        threading.Thread(target=self._run, args=(task, model), daemon=True).start()
        return None

    # ---- internals -----------------------------------------------------------
    def _emit(self, model_id: str, received: int, total: int, done: bool, error: str | None = None) -> None:
        event = {
            "type": "download",
            "id": model_id,
            "receivedBytes": int(received),
            "totalBytes": int(total),
            "done": done,
        }
        if error is not None:
            event["error"] = error
        self.bus.publish(event)

    def _run(self, task: DownloadTask, model: dict) -> None:
        model_id = task.model_id
        total = int(model["totalBytes"]) or 1
        weights_cap = int(total * ENV_PHASE_FRACTION)
        try:
            received_base = 0
            monotonic_max = 0
            for repo in model["repos"]:
                if task.cancelled.is_set():
                    raise InterruptedError("cancelled")
                repo_total = int(repo["bytes"])
                proc = self._spawn_fetch(repo)
                task.proc = proc
                while proc.poll() is None:
                    if task.cancelled.is_set():
                        proc.terminate()
                        raise InterruptedError("cancelled")
                    on_disk = min(bytes_on_disk(self.registry.hf_home, repo["repo"]), repo_total)
                    monotonic_max = max(monotonic_max, min(received_base + on_disk, weights_cap))
                    self._emit(model_id, monotonic_max, total, False)
                    time.sleep(1.0)
                if proc.returncode != 0:
                    raise RuntimeError(f"download failed for {repo['repo']} (exit {proc.returncode})")
                received_base += repo_total
                monotonic_max = max(monotonic_max, min(received_base, weights_cap))
                self._emit(model_id, monotonic_max, total, False)

            # Weights complete — provision the runtime env (venv/clone/binary).
            self._emit(model_id, weights_cap, total, False)

            def log(msg: str) -> None:
                print(f"[gen3d provision {model_id}] {msg}", flush=True)

            envs.provision(self.registry, model, log, task.cancelled)
            if task.cancelled.is_set():
                raise InterruptedError("cancelled")
            self.registry.write_stamp(model_id)
            self._emit(model_id, total, total, True)
            self.bus.publish({"type": "catalog-changed", "at": int(time.time() * 1000)})
        except InterruptedError:
            self._emit(model_id, 0, total, True, "cancelled")
        except Exception as err:  # noqa: BLE001 — report, never crash the sidecar
            self._emit(model_id, 0, total, True, str(err))
        finally:
            task.done = True

    def _spawn_fetch(self, repo: dict) -> subprocess.Popen:
        """snapshot_download in a child process so cancel is a clean kill."""
        payload = {
            "repo": repo["repo"],
            "allow": list(repo.get("allowPatterns") or []) or None,
        }
        script = (
            "import json,sys,os\n"
            "from huggingface_hub import snapshot_download\n"
            "spec=json.loads(sys.argv[1])\n"
            "snapshot_download(spec['repo'], allow_patterns=spec['allow'])\n"
        )
        env = dict(os.environ)
        env["HF_HOME"] = str(self.registry.hf_home)
        return subprocess.Popen(
            [sys.executable, "-c", script, __import__("json").dumps(payload)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )
