"""Model registry + on-disk layout. Facts (repos/patterns/sizes) come from the
TypeScript catalog via the --registry JSON; this module owns PATHS and the
installed-state checks against them.

Layout under the cache root (~/.cache/pi-desktop/gen3d):
  hf/         HF_HOME for every weight download (standard hub cache)
  src/        cloned tool repos + their venvs (trellis-mac, Mage, cube, ...)
  bin/        the AutoRemesher .app
  installed/  <model-id>.json stamps written after weights+env verification
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

# Pinned tool-repo commits (verified working together on this hardware,
# 2026-07-23). Bump deliberately.
TOOL_REPOS = {
    "trellis-mac": (
        "https://github.com/shivampkumar/trellis-mac.git",
        "d58628f4f5b9c3de8274cb110074154f4b31cef2",
    ),
    "Mage": (
        "https://github.com/microsoft/Mage.git",
        "df7f84d9f8fc991d189d929f03cff623b430a4a2",
    ),
    "cube": (
        "https://github.com/Roblox/cube.git",
        "3c6d06ddbef3160a1e1950cb13ab63dd12a61e50",
    ),
}


class Registry:
    def __init__(self, spec: dict, cache_dir: Path) -> None:
        self.spec = spec
        self.cache_dir = cache_dir
        self.hf_home = cache_dir / "hf"
        self.src_dir = cache_dir / "src"
        self.bin_dir = cache_dir / "bin"
        self.stamp_dir = cache_dir / "installed"
        for d in (self.hf_home, self.src_dir, self.bin_dir, self.stamp_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.uv_path = shutil.which("uv") or str(Path.home() / ".local" / "bin" / "uv")

    @classmethod
    def load(cls, registry_path: Path, cache_dir: Path) -> "Registry":
        return cls(json.loads(registry_path.read_text()), cache_dir)

    # ---- spec access ------------------------------------------------------
    def model_ids(self) -> list[str]:
        return [m["id"] for m in self.spec["models"]]

    def model(self, model_id: str) -> dict | None:
        for m in self.spec["models"]:
            if m["id"] == model_id:
                return m
        return None

    def pipeline_type(self, resolution: str) -> str:
        return self.spec["pipelineTypes"].get(resolution, "512")

    # ---- paths -------------------------------------------------------------
    def stamp_path(self, model_id: str) -> Path:
        return self.stamp_dir / f"{model_id}.json"

    def tool_dir(self, name: str) -> Path:
        return self.src_dir / name

    def venv_python(self, tool: str) -> Path:
        return self.tool_dir(tool) / ".venv" / "bin" / "python"

    def autoremesher_cli(self) -> Path:
        return self.bin_dir / "autoremesher.app" / "Contents" / "MacOS" / "autoremesher"

    def mflux_cli(self) -> Path:
        """Mage-Flow-Turbo via mflux (MIT) — the FAST image path.

        MEASURED, all outputs checked by eye: Mage-Flow-Turbo on PyTorch MPS
        71s; FLUX.2 Klein 4B on MLX 13s / 17.94 GB; Mage-Flow-Turbo on MLX
        **11s / 14.69 GB** at 8-bit — fastest, lightest, and the best image.
        (4-bit Mage-Flow renders NOISE while exiting 0 — see mlx_image_worker.)
        """
        return self.tool_dir("mflux") / ".venv" / "bin" / "mflux-generate-mage-flow"

    def quadriflow_cli(self) -> Path:
        """QuadriFlow (MIT) — the PRIMARY quad remesher.

        AutoRemesher could not remesh TRELLIS output at all on this machine: it
        dies on an assertion inside its vendored geogram 1.8.3
        (`hexdom/quad_cover.cpp:207`) even on a flawless watertight mesh, and at
        smaller inputs it simply never converges (measured: crash in 2-4s at
        200k faces, >7min no-output at 30k and 80k, every target-quad setting).
        QuadriFlow remeshed the identical model in 15s at 100% quads. It is also
        a plain CLI with no Qt, so it cannot take a dock tile.
        """
        return self.bin_dir / "quadriflow"

    def mlx_trellis_dir(self) -> Path:
        """The MLX TRELLIS checkout, when it has been provisioned."""
        return self.tool_dir("trellis2-apple")

    def geometry_tool_dir(self) -> Path:
        """MLX TRELLIS when present, else the PyTorch-MPS checkout.

        MEASURED on the same image at 512, both output meshes rendered and
        compared side by side (indistinguishable): MPS 225s (82s load + 137s
        generate) vs MLX **76s** (3s + 73s) — 3x, at identical quality.
        """
        mlx = self.mlx_trellis_dir()
        return mlx if (mlx / ".venv" / "bin" / "python").exists() else self.tool_dir("trellis-mac")

    def trellis_snapshot_dir(self) -> Path | None:
        """The cached TRELLIS.2-4B snapshot dir (has pipeline.json + ckpts)."""
        base = self.hf_home / "hub" / "models--microsoft--TRELLIS.2-4B" / "snapshots"
        if not base.exists():
            return None
        for d in sorted(base.iterdir()):
            if (d / "pipeline.json").exists():
                return d
        return None

    def geometry_python(self) -> Path:
        return self.geometry_tool_dir() / ".venv" / "bin" / "python"

    def skintokens_dir(self) -> Path:
        """The SkinTokens checkout, when it has been provisioned."""
        return self.tool_dir("SkinTokens")

    def skintokens_python(self) -> Path:
        return self.skintokens_dir() / ".venv" / "bin" / "python"

    def has_skintokens(self) -> bool:
        """True when the learned rigger is usable.

        Needs the venv AND the checkpoint: a half-provisioned checkout would
        otherwise take the rig stage and fail at load, when the geometric rigger
        would have produced something.
        """
        ckpt = (
            self.skintokens_dir()
            / "experiments"
            / "articulation_xl_quantization_256_token_4"
            / "grpo_1400.ckpt"
        )
        return self.skintokens_python().exists() and ckpt.exists()

    def meshtools_python(self) -> Path:
        return self.tool_dir("meshtools") / ".venv" / "bin" / "python"

    # ---- installed checks ---------------------------------------------------
    def weights_present(self, model_id: str) -> bool:
        """True when every repo snapshot resolves offline (hf cache complete)."""
        model = self.model(model_id)
        if model is None:
            return False
        if not model["repos"]:
            return True
        try:
            from huggingface_hub import snapshot_download
        except ImportError:
            return False
        for repo in model["repos"]:
            try:
                snapshot_download(
                    repo["repo"],
                    allow_patterns=list(repo.get("allowPatterns") or []) or None,
                    local_files_only=True,
                )
            except Exception:
                return False
        return True

    def env_present(self, model_id: str) -> bool:
        model = self.model(model_id)
        if model is None:
            return False
        env = model["env"]
        if env == "trellis":
            return self.venv_python("trellis-mac").exists()
        if env == "mageflow":
            return self.venv_python("Mage").exists()
        if env == "cubepart":
            # Cube3D and CubePart are two models in ONE checkout and share its
            # venv, so the same env check serves both.
            return self.venv_python("cube").exists()
        if env == "paint":
            return self.venv_python("Hunyuan3D-2.1-mac").exists()
        if env == "binary":
            return self.autoremesher_cli().exists() and self.meshtools_python().exists()
        if env == "meshtools":
            # The humanoid rigger runs entirely inside the mesh-prep venv —
            # nothing to download, so "installed" == the venv is usable.
            return self.meshtools_python().exists()
        return False

    def is_installed(self, model_id: str) -> bool:
        if not (self.weights_present(model_id) and self.env_present(model_id)):
            return False
        # A stamp records "the download finished". Models with NO weights to
        # download (the AutoRemesher binary, the local humanoid rigger) are
        # fully described by env_present, and demanding a stamp they can never
        # earn just makes a working tool look uninstalled.
        model = self.model(model_id)
        if model is not None and not model["repos"]:
            return True
        return self.stamp_path(model_id).exists()

    def write_stamp(self, model_id: str) -> None:
        self.stamp_path(model_id).write_text(json.dumps({"id": model_id, "ok": True}))

    # ---- git ----------------------------------------------------------------
    def ensure_tool_clone(self, name: str, log) -> Path:
        url, pin = TOOL_REPOS[name]
        dest = self.tool_dir(name)
        if not dest.exists():
            log(f"Cloning {name}…")
            subprocess.run(["git", "clone", url, str(dest)], check=True, capture_output=True)
        subprocess.run(
            ["git", "-C", str(dest), "checkout", pin], check=True, capture_output=True
        )
        return dest
