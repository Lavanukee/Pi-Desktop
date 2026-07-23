"""Job orchestration: one generation/stage job = a sequence of worker
subprocesses (each in its own provisioned venv) run one at a time — on a
24 GB unified-memory machine the previous stage's weights MUST be out of RAM
before the next stage loads. A worker emits NDJSON on stdout:

  {"event":"progress","stage":"geometry","message":"…","step":3,"totalSteps":12}
  {"event":"artifact","stage":"geometry","kind":"model-glb","path":"…","label":"…"}
  {"event":"stage-done","stage":"geometry"}
  {"event":"error","message":"…"}

jobs.py forwards them onto the /events bus as {type:"job", …} with the
stageIndex resolved against the job's plan (stage order mirrors the
TypeScript planGenerate/planStageOp — weights live only in TS).

Artifacts are written under <sandbox>/<jobId>/ — the renderer-readable fence.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import uuid
from pathlib import Path

from .bus import EventBus
from .registry import Registry

WORKERS_DIR = Path(__file__).resolve().parent.parent / "workers"


def _worker_env(registry: Registry) -> dict:
    env = dict(os.environ)
    env["HF_HOME"] = str(registry.hf_home)
    # Must be set before torch import anywhere in the worker.
    env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    env["ATTN_BACKEND"] = "sdpa"
    env["SPARSE_ATTN_BACKEND"] = "sdpa"
    # mage_flow's own override: forces the Qwen3-VL text encoder off
    # flash_attention_2 on machines without flash-attn (i.e. every Mac).
    env["VF_HF_ATTN_IMPL"] = "sdpa"
    env["PYTHONUNBUFFERED"] = "1"
    return env


class Job:
    def __init__(self, job_id: str, plan: list[str]) -> None:
        self.job_id = job_id
        self.plan = plan
        self.cancelled = threading.Event()
        self.proc: subprocess.Popen | None = None


class JobManager:
    def __init__(self, registry: Registry, bus: EventBus, sandbox_dir: Path) -> None:
        self.registry = registry
        self.bus = bus
        self.sandbox_dir = sandbox_dir
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    # ---- public -------------------------------------------------------------
    def start_generate(self, body: dict) -> dict:
        kind = body.get("kind")
        texture = bool(body.get("texture"))
        resolution = body.get("resolution") or "low"
        prompt = (body.get("prompt") or "").strip()
        image_path = body.get("imagePath") or ""

        if kind == "text":
            if not prompt:
                return {"ok": False, "error": "a prompt is required for text → 3D"}
            if not self.registry.is_installed("mageflow"):
                return {"ok": False, "error": "Mage-Flow is not installed yet"}
        elif kind == "image":
            if not image_path or not Path(image_path).exists():
                return {"ok": False, "error": "input image not found"}
        else:
            return {"ok": False, "error": f"unknown kind: {kind}"}
        if not self.registry.is_installed("trellis2"):
            return {"ok": False, "error": "TRELLIS-2 is not installed yet"}

        plan = (["image"] if kind == "text" else []) + ["geometry"] + (["texture"] if texture else [])
        job = self._new_job(plan)
        threading.Thread(
            target=self._run_generate,
            args=(job, kind, prompt, image_path, resolution, texture),
            daemon=True,
        ).start()
        return {"ok": True, "jobId": job.job_id}

    def start_stage(self, body: dict) -> dict:
        op = body.get("op")
        model_path = body.get("modelPath") or ""
        prompt = (body.get("prompt") or "").strip()
        if op not in ("segment", "retopo", "texture"):
            return {"ok": False, "error": f"unknown stage op: {op}"}
        if not model_path or not Path(model_path).exists():
            return {"ok": False, "error": "model file not found"}
        required = {"segment": "cubepart", "retopo": "autoremesher", "texture": "hunyuan-paint"}[op]
        if not self.registry.is_installed(required):
            return {"ok": False, "error": f"{required} is not installed yet"}

        job = self._new_job([op])
        threading.Thread(
            target=self._run_stage, args=(job, op, model_path, prompt), daemon=True
        ).start()
        return {"ok": True, "jobId": job.job_id}

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            return False
        job.cancelled.set()
        proc = job.proc
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                proc.terminate()
        return True

    # ---- internals ------------------------------------------------------------
    def _new_job(self, plan: list[str]) -> Job:
        job_id = uuid.uuid4().hex[:12]
        job = Job(job_id, plan)
        with self._lock:
            self._jobs[job_id] = job
        (self.sandbox_dir / job_id).mkdir(parents=True, exist_ok=True)
        return job

    def _job_dir(self, job: Job) -> Path:
        return self.sandbox_dir / job.job_id

    def _publish(self, job: Job, stage: str, **fields) -> None:
        stage_index = job.plan.index(stage) if stage in job.plan else 0
        event = {
            "type": "job",
            "jobId": job.job_id,
            "stage": stage,
            "stageIndex": stage_index,
            "done": False,
            "message": "",
        }
        event.update(fields)
        self.bus.publish(event)

    def _run_generate(
        self, job: Job, kind: str, prompt: str, image_path: str, resolution: str, texture: bool
    ) -> None:
        job_dir = self._job_dir(job)
        try:
            if kind == "text":
                self._publish(job, "image", message="Loading Mage-Flow Turbo…")
                image_out = job_dir / "prompt-image.png"
                self._run_worker(
                    job,
                    self.registry.venv_python("Mage"),
                    WORKERS_DIR / "mageflow_worker.py",
                    [
                        "--prompt", prompt,
                        "--out", str(image_out),
                        "--model", "microsoft/Mage-Flow-Turbo",
                    ],
                    cwd=self.registry.tool_dir("Mage"),
                    default_stage="image",
                )
                if job.cancelled.is_set():
                    raise InterruptedError
                image_path = str(image_out)

            self._publish(job, "geometry", message="Loading TRELLIS-2 pipeline (≈100 s)…")
            self._run_worker(
                job,
                self.registry.venv_python("trellis-mac"),
                WORKERS_DIR / "trellis_worker.py",
                [
                    "--image", image_path,
                    "--out-dir", str(job_dir),
                    "--pipeline-type", self.registry.pipeline_type(resolution),
                    "--texture" if texture else "--no-texture",
                    *((["--prompt", prompt]) if prompt else []),
                ],
                cwd=self.registry.tool_dir("trellis-mac"),
                default_stage="geometry",
            )
            if job.cancelled.is_set():
                raise InterruptedError
            final_stage = "texture" if texture else "geometry"
            self._publish(job, final_stage, message="Done", done=True, stageDone=True)
        except InterruptedError:
            self._publish(job, job.plan[0], message="Cancelled", done=True, error="cancelled")
        except Exception as err:  # noqa: BLE001
            stage = job.plan[-1]
            self._publish(job, stage, message=str(err), done=True, error=str(err))

    def _run_stage(self, job: Job, op: str, model_path: str, prompt: str) -> None:
        job_dir = self._job_dir(job)
        try:
            if op == "segment":
                venv = self.registry.venv_python("cube")
                script = WORKERS_DIR / "cubepart_worker.py"
                args = [
                    "--mesh", model_path,
                    "--out-dir", str(job_dir),
                    "--cube-dir", str(self.registry.tool_dir("cube")),
                ]
                if prompt:
                    args += ["--parts", prompt]
                cwd = self.registry.tool_dir("cube")
            elif op == "retopo":
                venv = self.registry.meshtools_python()
                script = WORKERS_DIR / "retopo_worker.py"
                args = [
                    "--mesh", model_path,
                    "--out-dir", str(job_dir),
                    "--cli", str(self.registry.autoremesher_cli()),
                ]
                cwd = self.registry.tool_dir("meshtools")
            else:  # texture (Hunyuan Paint)
                venv = self.registry.venv_python("Hunyuan3D-2.1-mac")
                script = WORKERS_DIR / "paint_worker.py"
                args = [
                    "--mesh", model_path,
                    "--out-dir", str(job_dir),
                    "--tool-dir", str(self.registry.tool_dir("Hunyuan3D-2.1-mac")),
                    *(["--prompt", prompt] if prompt else []),
                ]
                cwd = self.registry.tool_dir("Hunyuan3D-2.1-mac")

            self._publish(job, op, message=f"Starting {op}…")
            self._run_worker(job, venv, script, args, cwd=cwd, default_stage=op)
            if job.cancelled.is_set():
                raise InterruptedError
            self._publish(job, op, message="Done", done=True, stageDone=True)
        except InterruptedError:
            self._publish(job, op, message="Cancelled", done=True, error="cancelled")
        except Exception as err:  # noqa: BLE001
            self._publish(job, op, message=str(err), done=True, error=str(err))

    def _run_worker(
        self,
        job: Job,
        venv_python: Path,
        script: Path,
        args: list[str],
        cwd: Path,
        default_stage: str,
    ) -> None:
        if job.cancelled.is_set():
            raise InterruptedError
        proc = subprocess.Popen(
            [str(venv_python), str(script), *args],
            cwd=str(cwd),
            env=_worker_env(self.registry),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,  # killpg on cancel reaps grandchildren too
        )
        job.proc = proc
        stderr_tail: list[str] = []

        def drain_stderr() -> None:
            assert proc.stderr is not None
            for line in proc.stderr:
                stderr_tail.append(line)
                if len(stderr_tail) > 40:
                    stderr_tail.pop(0)

        threading.Thread(target=drain_stderr, daemon=True).start()
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue  # plain print noise from libraries
            event = msg.get("event")
            stage = msg.get("stage") or default_stage
            if event == "progress":
                self._publish(
                    job,
                    stage,
                    message=msg.get("message", ""),
                    **{
                        k: msg[k]
                        for k in ("step", "totalSteps")
                        if isinstance(msg.get(k), (int, float))
                    },
                )
            elif event == "artifact":
                self._publish(
                    job,
                    stage,
                    message=msg.get("message", ""),
                    artifact={
                        "kind": msg.get("kind", "model-glb"),
                        "path": msg.get("path", ""),
                        "label": msg.get("label", ""),
                    },
                )
            elif event == "stage-done":
                self._publish(job, stage, message=msg.get("message", ""), stageDone=True)
            elif event == "error":
                raise RuntimeError(msg.get("message", "worker error"))
        code = proc.wait()
        job.proc = None
        if job.cancelled.is_set():
            raise InterruptedError
        if code != 0:
            tail = "".join(stderr_tail).strip()[-1500:]
            raise RuntimeError(f"worker exited {code}: {tail or 'no stderr'}")
