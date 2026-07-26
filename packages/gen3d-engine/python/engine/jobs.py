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
import time
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
    # MLX TRELLIS: tell the worker where the (already-cached) TRELLIS.2-4B
    # snapshot lives — its MLX pipeline loads from a directory, not a repo id.
    # Set ONLY when the MLX checkout is provisioned, so the MPS worker is
    # untouched on machines without it.
    if (registry.mlx_trellis_dir() / ".venv" / "bin" / "python").exists():
        snap = registry.trellis_snapshot_dir()
        if snap is not None:
            env["PI_GEN3D_MLX_WEIGHTS"] = str(snap)
        # The Metal kernels are compiled by `xcrun metal`, which CommandLineTools
        # does not ship. Point at Xcode for this process only when it is present
        # — a per-process override, no sudo and no change to xcode-select.
        xcode = Path("/Applications/Xcode.app/Contents/Developer")
        if "DEVELOPER_DIR" not in env and xcode.exists():
            env["DEVELOPER_DIR"] = str(xcode)
    # SkinTokens: run the rigger in fp32. Its `@torch.autocast('cuda')`
    # decorators bind at IMPORT time and the venv's .pth reads this at
    # interpreter start, so it has to arrive as an environment variable —
    # a flag parsed inside the worker would already be too late.
    env.setdefault("PI_ST_AUTOCAST", "off")
    return env


def _find_voxels(mesh_path: Path, source_path: str | None) -> Path | None:
    """The colour volume to re-texture `mesh_path` from, or None.

    Texturing samples the volume saved by the GENERATION, so a mesh that has
    since been retopologised or segmented lives in a different job dir than its
    colours. The caller passes `sourcePath` — the asset's root version — and the
    volume is looked for next to whichever of the two has it. Returning None is
    a real answer: an imported mesh has no colours, and the worker says so
    rather than quietly emitting an untextured GLB.
    """
    for candidate in (mesh_path, Path(source_path) if source_path else None):
        if candidate is None:
            continue
        voxels = candidate.parent / "voxels.npz"
        if voxels.exists():
            return voxels
    return None


class Job:
    def __init__(self, job_id: str, plan: list[str]) -> None:
        self.job_id = job_id
        self.plan = plan
        self.cancelled = threading.Event()
        self.proc: subprocess.Popen | None = None


# How long a warm worker may sit idle holding its weights before we release
# them. Long enough to cover "look at the result, tweak, regenerate" (the loop
# that pays for warmth); short enough that an abandoned session gives the RAM
# back. Set PI_GEN3D_WARM=0 to disable warm workers entirely.
WARM_IDLE_SECONDS = float(os.environ.get("PI_GEN3D_WARM_IDLE", "300"))


class _WarmWorker:
    """A worker process kept ALIVE between jobs so its model stays resident.

    Loading TRELLIS-2 costs a MEASURED 82s of a 225s 512 geometry run — 36% of
    wall-clock, paid on every job because a worker is normally one subprocess per
    job. This keeps one such process parked on `--serve`, feeding it a JSON line
    per job and reading the same NDJSON back, so repeat generations skip the load.

    ONE at a time, deliberately: this module's contract is that on a 24 GB
    machine the previous stage's weights must be out of RAM before the next
    stage loads, so a warm worker is released before any DIFFERENT worker runs.
    """

    def __init__(self, key: str, proc: subprocess.Popen) -> None:
        self.key = key
        self.proc = proc
        # Seed with "now": a 0.0 here would read as infinitely idle and let the
        # reaper kill the worker DURING its very first job.
        self.last_used = time.time()
        # True while a job is streaming through it — never reap a running job.
        self.busy = False

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None

    def submit(self, args: list[str]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(args) + "\n")
        self.proc.stdin.flush()

    def kill(self) -> None:
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                self.proc.terminate()
            except OSError:
                pass


class JobManager:
    def __init__(self, registry: Registry, bus: EventBus, sandbox_dir: Path) -> None:
        self.registry = registry
        self.bus = bus
        self.sandbox_dir = sandbox_dir
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        # At most ONE parked worker (see _WarmWorker): holding two models would
        # break this module's "previous stage's weights out of RAM first" rule.
        self._warm: _WarmWorker | None = None
        self._warm_lock = threading.Lock()
        self._warm_enabled = os.environ.get("PI_GEN3D_WARM", "1") != "0"
        if self._warm_enabled:
            threading.Thread(target=self._warm_reaper, daemon=True).start()

    # ---- public -------------------------------------------------------------
    def start_generate(self, body: dict) -> dict:
        kind = body.get("kind")
        texture = bool(body.get("texture"))
        resolution = body.get("resolution") or "low"
        prompt = (body.get("prompt") or "").strip()
        # New contract: one-or-more unlabeled images (TRELLIS pools them). Fall
        # back to the old singular field for compatibility.
        image_paths = list(body.get("imagePaths") or [])
        if not image_paths and body.get("imagePath"):
            image_paths = [body["imagePath"]]
        # imageOnly stops after the text→image hop (the Image panel's use).
        image_only = bool(body.get("imageOnly"))
        engine = body.get("engine") or "trellis2"
        texture_size = int(body.get("textureSize") or 0)
        parts = [str(p).strip() for p in (body.get("parts") or []) if str(p).strip()]
        # Cube3D is TEXT→SHAPE. It needs no image model, produces no texture,
        # and can hand straight to CubePart — so it skips most of what follows.
        cube3d = engine == "cube3d" and kind == "text" and not image_only

        if kind == "text":
            if not prompt:
                return {"ok": False, "error": "a prompt is required for text → 3D"}
            if cube3d:
                if not self.registry.is_installed("cube3d"):
                    return {"ok": False, "error": "Cube 3D is not installed yet"}
                if parts and not self.registry.is_installed("cubepart"):
                    return {"ok": False, "error": "CubePart is not installed yet"}
            elif not self.registry.is_installed("mageflow"):
                return {"ok": False, "error": "Mage-Flow is not installed yet"}
        elif kind == "image":
            image_paths = [p for p in image_paths if p and Path(p).exists()]
            if not image_paths:
                return {"ok": False, "error": "input image not found"}
        else:
            return {"ok": False, "error": f"unknown kind: {kind}"}
        # The geometry model is only needed when we actually reach it.
        if not image_only and not cube3d and not self.registry.is_installed("trellis2"):
            return {"ok": False, "error": "TRELLIS-2 is not installed yet"}

        if cube3d:
            plan = ["geometry"] + (["segment"] if parts else [])
            job = self._new_job(plan)
            threading.Thread(
                target=self._run_cube3d,
                args=(job, prompt, parts),
                daemon=True,
            ).start()
            return {"ok": True, "jobId": job.job_id}

        if image_only:
            plan = ["image"]
        else:
            plan = (
                (["image"] if kind == "text" else [])
                + ["geometry"]
                + (["texture"] if texture else [])
            )
        job = self._new_job(plan)
        threading.Thread(
            target=self._run_generate,
            args=(job, kind, prompt, image_paths, resolution, texture, image_only, texture_size),
            daemon=True,
        ).start()
        return {"ok": True, "jobId": job.job_id}

    def _run_cube3d(self, job: Job, prompt: str, parts: list[str]) -> None:
        """Text → shape with no image hop, optionally split into named parts."""
        job_dir = self.sandbox_dir / job.job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        try:
            args = [
                "--prompt", prompt,
                "--out-dir", str(job_dir),
                "--cube-dir", str(self.registry.tool_dir("cube")),
            ]
            if parts:
                args += ["--parts", ",".join(parts)]
            self._publish(job, "geometry", message="Starting Cube 3D…")
            self._run_worker(
                job,
                self.registry.venv_python("cube"),
                WORKERS_DIR / "cube3d_worker.py",
                args,
                cwd=self.registry.tool_dir("cube"),
                default_stage="geometry",
            )
            if job.cancelled.is_set():
                raise InterruptedError
            self._publish(job, "geometry", message="Done", done=True, stageDone=True)
        except InterruptedError:
            self._publish(job, "geometry", message="Cancelled", done=True, error="cancelled")
        except Exception as err:  # noqa: BLE001
            self._publish(job, "geometry", message=str(err), done=True, error=str(err))

    def start_stage(self, body: dict) -> dict:
        op = body.get("op")
        model_path = body.get("modelPath") or ""
        prompt = (body.get("prompt") or "").strip()
        if op not in ("segment", "retopo", "texture", "rig"):
            return {"ok": False, "error": f"unknown stage op: {op}"}
        if not model_path or not Path(model_path).exists():
            return {"ok": False, "error": "model file not found"}
        required = {
            "segment": "cubepart",
            "retopo": "autoremesher",
            "texture": "trellis2",
            "rig": "humanoid-rig",
        }[op]
        if not self.registry.is_installed(required):
            return {"ok": False, "error": f"{required} is not installed yet"}

        # Stage tuning knobs travel as plain optional fields on the request.
        options = {
            k: body[k]
            for k in ("targetQuads", "adaptivity", "probeOnly", "requireHumanoid")
            if body.get(k) is not None
        }
        job = self._new_job([op])
        threading.Thread(
            target=self._run_stage, args=(job, op, model_path, prompt, options), daemon=True
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

    def _image_worker(self, prompt: str, out: Path) -> tuple[Path, Path, list[str], Path]:
        """(venv_python, script, args, cwd) for text→image — Klein first.

        MEASURED at 1024px, same prompt/steps, every output checked by eye:
        Mage-Flow-Turbo on PyTorch MPS 71s vs the same model on MLX at 8-bit
        11s / 14.69 GB — 6.5x, and it also beat FLUX.2 Klein (13s / 17.94 GB).
        So the MLX path is the default; the MPS worker stays as the fallback for
        a machine where mflux was never installed.
        """
        klein = self.registry.mflux_cli()
        if klein.exists():
            return (
                self.registry.venv_python("mflux"),
                WORKERS_DIR / "mlx_image_worker.py",
                ["--prompt", prompt, "--out", str(out), "--cli", str(klein)],
                self.registry.tool_dir("mflux"),
            )
        return (
            self.registry.venv_python("Mage"),
            WORKERS_DIR / "mageflow_worker.py",
            ["--prompt", prompt, "--out", str(out), "--model", "microsoft/Mage-Flow-Turbo"],
            self.registry.tool_dir("Mage"),
        )

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
        self,
        job: Job,
        kind: str,
        prompt: str,
        image_paths: list[str],
        resolution: str,
        texture: bool,
        image_only: bool = False,
        texture_size: int = 0,
    ) -> None:
        job_dir = self._job_dir(job)
        try:
            if kind == "text":
                self._publish(job, "image", message="Loading the image model…")
                image_out = job_dir / "prompt-image.png"
                self._run_worker(
                    job,
                    *self._image_worker(prompt, image_out),
                    default_stage="image",
                )
                if job.cancelled.is_set():
                    raise InterruptedError
                # The Image panel stops here (the worker already emitted the
                # image artifact); Make 3D re-enters as a kind='image' job.
                if image_only:
                    self._publish(job, "image", message="Image ready", done=True, stageDone=True)
                    return
                image_paths = [str(image_out)]

            self._publish(job, "geometry", message="Loading TRELLIS-2 pipeline (≈100 s)…")
            # One-or-more unlabeled input images (TRELLIS pools multi-image).
            image_args = [a for p in image_paths for a in ("--image", p)]
            self._run_worker(
                job,
                self.registry.geometry_python(),
                WORKERS_DIR / "trellis_worker.py",
                [
                    *image_args,
                    "--out-dir", str(job_dir),
                    "--pipeline-type", self.registry.pipeline_type(resolution),
                    "--texture" if texture else "--no-texture",
                    *(["--texture-size", str(texture_size)] if texture_size > 0 else []),
                    *((["--prompt", prompt]) if prompt else []),
                ],
                cwd=self.registry.geometry_tool_dir(),
                default_stage="geometry",
                # The 82s pipeline load is the single biggest slice of a 512 run;
                # park this worker so a re-generate skips it entirely.
                warm=True,
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

    def _run_stage(
        self, job: Job, op: str, model_path: str, prompt: str, options: dict | None = None
    ) -> None:
        job_dir = self._job_dir(job)
        options = options or {}
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
                    "--quadriflow", str(self.registry.quadriflow_cli()),
                    "--target-quads", str(int(options.get("targetQuads") or 20_000)),
                    "--adaptivity", str(float(options.get("adaptivity") or 1.0)),
                ]
                cwd = self.registry.tool_dir("meshtools")
            elif op == "rig":
                # SkinTokens when it is installed: it PREDICTS the skeleton and
                # the skin weights for any mesh, where rig_worker.py fits a
                # fixed 27-joint humanoid template by measuring the shape. The
                # geometric rigger stays as the fallback so the stage still
                # works on a machine without the checkout, and it is the only
                # one that can answer the "is this humanoid?" probe.
                if self.registry.has_skintokens() and not options.get("probeOnly"):
                    venv = self.registry.skintokens_python()
                    script = WORKERS_DIR / "skintokens_worker.py"
                    args = [
                        "--mesh", model_path,
                        "--out-dir", str(job_dir),
                        "--root", str(self.registry.skintokens_dir()),
                        # fp32: bfloat16 on MPS returns a structurally valid rig
                        # whose joints do not match its own skin weights.
                        "--dtype", "float32",
                    ]
                    cwd = self.registry.skintokens_dir()
                else:
                    venv = self.registry.meshtools_python()
                    script = WORKERS_DIR / "rig_worker.py"
                    args = ["--mesh", model_path, "--out-dir", str(job_dir)]
                    if options.get("probeOnly"):
                        args.append("--probe-only")
                    if options.get("requireHumanoid"):
                        args.append("--require-humanoid")
                    cwd = self.registry.tool_dir("meshtools")
            else:  # texture — TRELLIS re-bakes from the colours it already made
                # No separate texture model: the generation saved its voxel
                # colour field next to the mesh, so this re-bakes from that.
                # Costs no weights and no load — the pipeline is never touched.
                venv = self.registry.geometry_python()
                script = WORKERS_DIR / "trellis_worker.py"
                args = [
                    "--bake-only",
                    "--mesh", model_path,
                    "--out-dir", str(job_dir),
                ]
                # A retopo/segment result lives in its own job dir; the colours
                # stay with the generation that produced them.
                voxels = _find_voxels(Path(model_path), options.get("sourcePath"))
                if voxels is not None:
                    args += ["--voxels", str(voxels)]
                cwd = self.registry.geometry_tool_dir()

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
        warm: bool = False,
    ) -> None:
        if job.cancelled.is_set():
            raise InterruptedError
        if warm and self._warm_enabled:
            try:
                self._run_warm(job, venv_python, script, args, cwd, default_stage)
                return
            except (InterruptedError, RuntimeError):
                raise  # a real job failure/cancel — not a warmth problem
            except Exception:
                # Anything else (broken pipe, dead process, protocol desync) is a
                # WARMTH failure: drop the parked worker and run cold below, so
                # this optimisation can never turn into a broken generation.
                self.release_warm("warm path failed")
        else:
            # A cold run of a DIFFERENT worker must not coexist with parked
            # weights on a 24 GB machine.
            self.release_warm("cold run")
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
        self._pump(job, proc.stdout, default_stage)
        code = proc.wait()
        job.proc = None
        if job.cancelled.is_set():
            raise InterruptedError
        if code != 0:
            tail = "".join(stderr_tail).strip()[-1500:]
            raise RuntimeError(f"worker exited {code}: {tail or 'no stderr'}")

    def _pump(self, job: Job, stdout, default_stage: str) -> None:
        """Forward one job's NDJSON onto the bus.

        Returns when the stream ends (one-shot worker) or on `job-done` (a
        served worker, which stays alive for the next job). An `error` event
        raises, exactly as before.
        """
        for line in stdout:
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
                        # A viewer-sized stand-in when the real mesh is too
                        # heavy to display (see trellis_worker).
                        **(
                            {"previewPath": msg["previewPath"]}
                            if msg.get("previewPath")
                            else {}
                        ),
                    },
                )
            elif event == "probe":
                # The rig worker's humanoid measurements — the UI asks the user
                # "humanoid?" from these rather than guessing.
                self._publish(job, stage, message="", humanoid=msg.get("humanoid"))
            elif event == "stage-done":
                self._publish(job, stage, message=msg.get("message", ""), stageDone=True)
            elif event == "error":
                raise RuntimeError(msg.get("message", "worker error"))
            elif event == "job-done":
                return  # served worker: this job is finished, process stays alive

    # ---- warm workers ---------------------------------------------------------
    def release_warm(self, reason: str = "") -> None:
        """Drop the parked worker so its weights leave RAM. Safe to call anytime."""
        with self._warm_lock:
            warm, self._warm = self._warm, None
        if warm is not None:
            warm.kill()

    def _warm_reaper(self) -> None:
        """Release a warm worker that has been idle too long (gives the RAM back)."""
        while True:
            time.sleep(15)
            with self._warm_lock:
                warm = self._warm
                idle = (
                    warm is not None
                    and not warm.busy
                    and (time.time() - warm.last_used) > WARM_IDLE_SECONDS
                )
            if idle:
                self.release_warm("idle")

    def _run_warm(
        self,
        job: Job,
        venv_python: Path,
        script: Path,
        args: list[str],
        cwd: Path,
        default_stage: str,
    ) -> None:
        """Run `args` on a parked `--serve` worker, starting one if needed.

        Raises like `_run_worker` so the caller's error handling is unchanged. If
        the parked process is missing/dead the caller falls back to a cold run,
        so warmth is an optimisation that can never block a job.
        """
        key = str(script)
        with self._warm_lock:
            # The 24 GB invariant: never hold two models. A different worker
            # means the parked one must go first.
            if self._warm is not None and (self._warm.key != key or not self._warm.alive):
                self._warm.kill()
                self._warm = None
            if self._warm is None:
                proc = subprocess.Popen(
                    [str(venv_python), str(script), "--serve"],
                    cwd=str(cwd),
                    env=_worker_env(self.registry),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    start_new_session=True,
                )
                self._warm = _WarmWorker(key, proc)
            warm = self._warm
            warm.busy = True  # inside the lock: the reaper must never see it idle
        job.proc = warm.proc  # cancel() kills it; the next job starts cold
        try:
            warm.submit(args)
            assert warm.proc.stdout is not None
            self._pump(job, warm.proc.stdout, default_stage)
        finally:
            job.proc = None
            warm.busy = False
            warm.last_used = time.time()
        if job.cancelled.is_set():
            # The process was signalled mid-job — it is no longer trustworthy.
            self.release_warm("cancelled")
            raise InterruptedError
