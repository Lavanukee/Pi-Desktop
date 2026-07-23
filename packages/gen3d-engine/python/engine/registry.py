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
    "Hunyuan3D-2.1-mac": (
        "https://github.com/Brainkeys/Hunyuan3D-2.1-mac.git",
        "8ce5756a665b24485e5597acce4ac587fac29ce7",
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
        import os

        os.environ.setdefault("HF_HOME", str(self.hf_home))
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
            return self.venv_python("cube").exists()
        if env == "paint":
            return self.venv_python("Hunyuan3D-2.1-mac").exists()
        if env == "binary":
            return self.autoremesher_cli().exists() and self.meshtools_python().exists()
        return False

    def is_installed(self, model_id: str) -> bool:
        return (
            self.stamp_path(model_id).exists()
            and self.weights_present(model_id)
            and self.env_present(model_id)
        )

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
