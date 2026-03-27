#!/usr/bin/env python3
"""
SearXNG Server Wrapper (Aether-owned, legal-clean externalization)

Goal:
- Ensure SearXNG is running as an EXTERNAL service (Docker-only by default).
- Never run vendored SearXNG source inside this repo (AGPL risk).
- Provide a single, deterministic entrypoint used by dev scripts (like OI wrapper).

@.architecture
Incoming: CLI args, config/settings.py (central config), docker compose --- {argv, Settings.integrations.searxng_url, docker}
Processing: ensure_running(), fail_fast_on_port_conflict(), wait_for_health() --- {3 jobs: JOB_INITIALIZE_COMPONENT, JOB_VALIDATE_CONFIG, JOB_ORCHESTRATE}
Outgoing: stdout/stderr, exit code --- {status lines, 0/1}
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx


def _repo_backend_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _require_ok(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def _run(cmd: list[str], *, cwd: Optional[Path] = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )

def _env_file(backend_root: Path) -> Path:
    return backend_root / "config" / "local.env"


def _compose_running(compose_file: Path, service: str) -> bool:
    proc = _run(["docker", "compose", "-f", str(compose_file), "ps", "--status", "running", "--services"])
    if proc.returncode != 0:
        return False
    lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    return service in lines


def _port_in_use(port: int) -> bool:
    proc = _run(["lsof", "-ti", f"tcp:{port}"])
    # lsof returns 0 if it found matches; 1 if none.
    return proc.returncode == 0 and bool((proc.stdout or "").strip())


def _wait_for_health(health_url: str, *, timeout_seconds: float) -> None:
    end = time.time() + float(timeout_seconds)
    while time.time() < end:
        try:
            r = httpx.get(health_url, timeout=2.0)
            if r.status_code < 400:
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"SearXNG did not become healthy in time: {health_url}")


def ensure_searxng(
    *,
    backend_root: Path,
    compose_file: Path,
    service: str,
    health_url: str,
    port: int,
    timeout_seconds: float,
) -> None:
    # Docker is mandatory in this wrapper.
    docker_ok = _run(["docker", "info"]).returncode == 0
    _require_ok(docker_ok, "Docker daemon not running (required for legal-clean SearXNG externalization)")

    already_running = _compose_running(compose_file, service)
    if already_running:
        _wait_for_health(health_url, timeout_seconds=timeout_seconds)
        print(f"✅ SearXNG already running + healthy at {health_url}")
        return

    # Fail-fast if the port is occupied by anything else.
    if _port_in_use(port):
        raise RuntimeError(
            f"Port {port} is already in use. Refusing to start Docker SearXNG. "
            f"Stop the conflicting process and retry."
        )

    env_file = _env_file(backend_root)
    _require_ok(env_file.exists(), f"Missing env file required for SearXNG: {env_file}")

    # Start via compose (single source of truth for volumes/settings).
    up = _run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(compose_file), "up", "-d", service],
        cwd=compose_file.parent,
    )
    _require_ok(up.returncode == 0, f"Failed to start SearXNG via docker compose:\n{up.stdout}")

    _wait_for_health(health_url, timeout_seconds=timeout_seconds)
    print(f"✅ Docker SearXNG started + healthy at {health_url}")


def _default_compose_file(backend_root: Path) -> Path:
    return backend_root / "services" / "perplexica" / "docker-compose.yaml"


def _derive_health_url(searxng_url: str) -> tuple[str, int]:
    parsed = urlparse(searxng_url)
    if parsed.scheme not in ("http", "https"):
        raise RuntimeError(f"Invalid searxng_url (must be http/https): {searxng_url}")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    # SearXNG exposes /healthz
    return f"{parsed.scheme}://{host}:{port}/healthz", port


def main() -> int:
    parser = argparse.ArgumentParser(description="Aether SearXNG wrapper (Docker-only, legal-clean).")
    parser.add_argument("--compose-file", default=None, help="Path to docker-compose.yaml that defines a searxng service")
    parser.add_argument("--service", default="searxng", help="Compose service name (default: searxng)")
    parser.add_argument("--searxng-url", default=None, help="Override SearXNG base URL (otherwise uses central settings)")
    parser.add_argument("--timeout", type=float, default=60.0, help="Health wait timeout (seconds)")
    args = parser.parse_args()

    backend_root = _repo_backend_root()
    if str(backend_root) not in sys.path:
        sys.path.insert(0, str(backend_root))

    # Central config is authoritative unless explicitly overridden.
    searxng_url = (args.searxng_url or "").strip()
    if not searxng_url:
        from config.settings import get_settings  # local import (avoid side effects before sys.path)

        settings = get_settings()
        searxng_url = str(settings.integrations.searxng_url).rstrip("/")

    health_url, port = _derive_health_url(searxng_url)

    compose_file = Path(args.compose_file).expanduser() if args.compose_file else _default_compose_file(backend_root)
    _require_ok(compose_file.exists(), f"Missing compose file: {compose_file}")

    ensure_searxng(
        backend_root=backend_root,
        compose_file=compose_file,
        service=str(args.service),
        health_url=health_url,
        port=port,
        timeout_seconds=float(args.timeout),
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

