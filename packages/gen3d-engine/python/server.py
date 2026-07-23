"""gen3d sidecar — the local HTTP server the Electron main process supervises.

stdlib-only HTTP (ThreadingHTTPServer); the single pip dep is huggingface_hub
(pinned by the uv launcher) for weight downloads + cache introspection. Heavy
inference NEVER runs in this process: each pipeline stage is a subprocess
worker in its own provisioned venv (workers/*.py) emitting NDJSON progress on
stdout, so RAM is reclaimed the instant a stage ends and a Metal-watchdog kill
never takes the sidecar down.

Endpoints (JSON in/out):
  GET  /health           -> {ok}
  GET  /catalog          -> {engineReady, models:[{id,installed,downloading}]}
  POST /download         {ids:[...]}            -> {ok}
  POST /cancel-download  {id}                   -> {ok}
  POST /generate         {kind,prompt,imagePath,resolution,texture} -> {ok,jobId}
  POST /stage            {op,modelPath,prompt}  -> {ok,jobId}
  POST /cancel           {jobId}                -> {ok}
  GET  /events           -> NDJSON stream: {type:"download"|"job"|"catalog-changed", ...}

The model registry (repos, allow-patterns, byte totals, gated mirrors) is
written by the TypeScript side (catalog.toSidecarRegistry()) and passed via
--registry so facts live in exactly one place.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine.bus import EventBus
from engine.downloads import DownloadManager
from engine.jobs import JobManager
from engine.registry import Registry

PROTOCOL_VERSION = 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--sandbox-dir", required=True)
    ap.add_argument("--registry", required=True)
    args = ap.parse_args()

    cache_dir = Path(args.cache_dir)
    sandbox_dir = Path(args.sandbox_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    sandbox_dir.mkdir(parents=True, exist_ok=True)

    registry = Registry.load(Path(args.registry), cache_dir)
    bus = EventBus()
    downloads = DownloadManager(registry, bus)
    jobs = JobManager(registry, bus, sandbox_dir)

    class Handler(BaseHTTPRequestHandler):
        # Silence per-request stderr noise (the supervisor logs our stdout).
        def log_message(self, fmt: str, *log_args: object) -> None:
            pass

        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            try:
                return json.loads(self.rfile.read(length))
            except (ValueError, OSError):
                return {}

        def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
            if self.path == "/health":
                self._json(200, {"ok": True, "version": PROTOCOL_VERSION})
                return
            if self.path == "/catalog":
                self._json(
                    200,
                    {
                        "engineReady": True,
                        "models": [
                            {
                                "id": model_id,
                                "installed": registry.is_installed(model_id),
                                "downloading": downloads.is_downloading(model_id),
                            }
                            for model_id in registry.model_ids()
                        ],
                    },
                )
                return
            if self.path == "/events":
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                queue = bus.subscribe()
                try:
                    while True:
                        event = queue.get()  # keepalives are emitted by the bus
                        self.wfile.write((json.dumps(event) + "\n").encode())
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    bus.unsubscribe(queue)
                return
            self._json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            body = self._read_body()
            if self.path == "/download":
                ids = body.get("ids") or []
                errors = [e for e in (downloads.start(i) for i in ids) if e]
                if errors:
                    self._json(200, {"ok": False, "error": "; ".join(errors)})
                else:
                    self._json(200, {"ok": True})
                return
            if self.path == "/cancel-download":
                self._json(200, {"ok": downloads.cancel(body.get("id", ""))})
                return
            if self.path == "/generate":
                result = jobs.start_generate(body)
                self._json(200, result)
                return
            if self.path == "/stage":
                result = jobs.start_stage(body)
                self._json(200, result)
                return
            if self.path == "/cancel":
                self._json(200, {"ok": jobs.cancel(body.get("jobId", ""))})
                return
            self._json(404, {"error": "not found"})

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    # Keepalive ticker so /events readers detect dead sockets and the TS side's
    # reconnect logic has something to chew on even when idle.
    threading.Thread(target=bus.keepalive_loop, daemon=True).start()
    print(f"gen3d sidecar listening on 127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
