"""
External Open Interpreter Server Pool (per-chat isolation)

Upstream Open Interpreter's `interpreter --server` uses a single global interpreter instance per
server *process*. That means multiple WebSocket clients share conversation state unless we isolate
at the process boundary.

This module provides a robust per-chat server pool:
- Spawn one OI server process per chat_id (true isolation, no vendor edits)
- Deterministic port allocation (fixed range)
- Hard cap + LRU eviction
- TTL eviction (idle servers)
- Fail-fast misconfiguration

@.architecture
Incoming: core/runtime/interpreter.py --- {chat_id, Settings.interpreter, Settings.base_url}
Processing: spawn/healthcheck/ttl-evict/lru-evict/terminate --- {5 jobs: JOB_MANAGE_PROCESSES, JOB_ALLOCATE_PORTS, JOB_HEALTHCHECK, JOB_EVICT_LRU, JOB_CLEANUP}
Outgoing: External OI server processes + URLs --- {http_url, ws_url, pid}
"""

from __future__ import annotations

import asyncio
import os
import signal
import socket
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx

import logging

logger = logging.getLogger(__name__)


@dataclass
class ExternalOIServerRecord:
    chat_id: str
    host: str
    port: int
    http_url: str
    ws_url: str
    pid: int
    started_at: float
    last_used: float

    # Internal handles (not part of public contract)
    _proc: subprocess.Popen
    _log_fp: Optional[Any] = None


class ExternalOIServerPool:
    """
    Spawn and manage one external OI server process per chat_id.
    """

    def __init__(
        self,
        *,
        base_external_url: str,
        host_override: Optional[str],
        port_min: int,
        port_max: int,
        max_servers: int,
        ttl_seconds: int,
        startup_timeout_seconds: float,
        venv_python: str,
        wrapper_script: str,
        backend_url: str,
        auth_token: Optional[str],
        logs_dir: str,
    ) -> None:
        self._base_external_url = (base_external_url or "").strip()
        if not self._base_external_url:
            raise ValueError("base_external_url is required")

        parsed = urlparse(self._base_external_url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(f"external_server_url must be http(s)://... (got {base_external_url!r})")
        if not parsed.hostname:
            raise ValueError(f"external_server_url missing hostname (got {base_external_url!r})")

        self._scheme_http = parsed.scheme
        self._scheme_ws = "wss" if parsed.scheme == "https" else "ws"
        self._host = (host_override or parsed.hostname).strip()
        if not self._host:
            raise ValueError("host is required")

        self._port_min = int(port_min)
        self._port_max = int(port_max)
        if self._port_min <= 0 or self._port_max <= 0 or self._port_min > self._port_max:
            raise ValueError(f"Invalid port range: {self._port_min}-{self._port_max}")

        self._max_servers = int(max_servers)
        if self._max_servers <= 0:
            raise ValueError("max_servers must be >= 1")

        self._ttl_seconds = int(ttl_seconds)
        if self._ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be >= 1")

        self._startup_timeout_seconds = float(startup_timeout_seconds)
        if self._startup_timeout_seconds <= 0:
            raise ValueError("startup_timeout_seconds must be > 0")

        self._venv_python = str(venv_python or "").strip()
        self._wrapper_script = str(wrapper_script or "").strip()
        if not self._venv_python:
            raise ValueError("venv_python is required")
        if not self._wrapper_script:
            raise ValueError("wrapper_script is required")
        if not Path(self._venv_python).exists():
            raise ValueError(f"venv_python does not exist: {self._venv_python}")
        if not Path(self._wrapper_script).exists():
            raise ValueError(f"wrapper_script does not exist: {self._wrapper_script}")

        self._backend_url = (backend_url or "").strip().rstrip("/")
        if not self._backend_url:
            raise ValueError("backend_url is required")

        self._auth_token = auth_token.strip() if isinstance(auth_token, str) and auth_token.strip() else None

        self._logs_dir = str(logs_dir or "").strip()
        if not self._logs_dir:
            raise ValueError("logs_dir is required")
        Path(self._logs_dir).mkdir(parents=True, exist_ok=True)

        self._lock = asyncio.Lock()
        self._servers: Dict[str, ExternalOIServerRecord] = {}
        # port -> chat_id (or "__reserved__:<chat_id>" during spawn)
        self._ports_in_use: Dict[int, str] = {}

        # Kill orphaned OI server processes from previous sessions BEFORE
        # cleaning logs.  This prevents leaked processes from accumulating
        # across backend restarts (since OI servers use start_new_session=True
        # and survive parent process death).
        self._kill_orphaned_oi_servers()

        # Clean stale OI per-chat logs from previous session (shell rotation handles
        # most of this, but guard against partial runs where the shell didn't rotate).
        self._clean_stale_oi_logs()

    def _kill_orphaned_oi_servers(self) -> None:
        """
        Scan the OI port range and kill any leftover oi_server_wrapper processes.

        These orphans survive backend restarts because they were spawned with
        start_new_session=True.  Without this scan, the pool has no knowledge
        of them and they leak indefinitely.
        """
        killed = 0
        for port in range(self._port_min, self._port_max + 1):
            if self._is_port_free(port):
                continue
            # Port is occupied — check if it's an OI wrapper from a previous session.
            try:
                pid = self._get_pid_on_port(port)
                if pid is None:
                    continue
                # Verify it's actually an oi_server_wrapper process
                if not self._is_oi_wrapper_process(pid):
                    continue
                logger.info(
                    "Killing orphaned OI server on port %d (PID %d) from previous session",
                    port, pid,
                )
                try:
                    os.killpg(pid, signal.SIGTERM)
                except (OSError, ProcessLookupError, PermissionError):
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except (OSError, ProcessLookupError, PermissionError):
                        pass
                killed += 1
            except Exception:  # noqa: BLE001 -- best-effort cleanup, must not block pool init
                pass
        if killed:
            # Brief wait for processes to exit
            time.sleep(0.5)
            logger.info("Cleaned %d orphaned OI server process(es)", killed)

    @staticmethod
    def _get_pid_on_port(port: int) -> Optional[int]:
        """Get PID of the process listening on a given port (best-effort)."""
        try:
            import subprocess as _sp
            result = _sp.run(
                ["lsof", "-ti", f":{port}"],
                capture_output=True, text=True, timeout=3,
            )
            if result.returncode == 0 and result.stdout.strip():
                # May return multiple PIDs; take the first (the listener)
                for line in result.stdout.strip().split("\n"):
                    line = line.strip()
                    if line.isdigit():
                        return int(line)
        except (FileNotFoundError, OSError, ValueError):
            pass
        return None

    @staticmethod
    def _is_oi_wrapper_process(pid: int) -> bool:
        """Check if a PID belongs to an oi_server_wrapper.py process."""
        try:
            cmdline_path = f"/proc/{pid}/cmdline"
            if os.path.exists(cmdline_path):
                # Linux: read /proc/PID/cmdline
                with open(cmdline_path, "rb") as f:
                    cmdline = f.read().decode("utf-8", errors="replace")
                return "oi_server_wrapper" in cmdline
            else:
                # macOS: use ps
                import subprocess as _sp
                result = _sp.run(
                    ["ps", "-p", str(pid), "-o", "command="],
                    capture_output=True, text=True, timeout=3,
                )
                return "oi_server_wrapper" in result.stdout
        except (OSError, FileNotFoundError, ValueError):
            return False

    def _clean_stale_oi_logs(self) -> None:
        """Remove OI per-chat log files and readiness sentinels from previous sessions."""
        try:
            logs_path = Path(self._logs_dir)
            removed = 0
            for pattern in ("oi-server-chat-*.log", "oi-server-*.ready"):
                for f in logs_path.glob(pattern):
                    try:
                        f.unlink()
                        removed += 1
                    except OSError:
                        pass
            if removed:
                logger.info("Cleaned %d stale OI per-chat artifact(s)", removed)
        except OSError as e:
            logger.debug("Failed to clean stale OI logs: %s", e)

    def list_servers(self) -> List[ExternalOIServerRecord]:
        return list(self._servers.values())

    async def ensure_server(self, chat_id: str) -> Tuple[ExternalOIServerRecord, bool]:
        """
        Ensure a server exists for chat_id.

        Returns (record, started_new).
        """
        if not chat_id or not isinstance(chat_id, str):
            raise ValueError("chat_id is required")

        # Phase 1: fast path under lock.
        async with self._lock:
            await self._cleanup_stale_locked()
            existing = self._servers.get(chat_id)
            if existing and self._is_alive(existing):
                existing.last_used = time.time()
                return existing, False
            if existing and not self._is_alive(existing):
                await self._stop_locked(chat_id)

            while len(self._servers) >= self._max_servers:
                await self._evict_lru_locked()

            port = self._allocate_port_locked()
            self._ports_in_use[port] = f"__reserved__:{chat_id}"

        # Phase 2: spawn + healthcheck outside lock.
        try:
            rec = await self._spawn_and_wait(chat_id=chat_id, port=port)
        except Exception as e:  # noqa: BLE001 -- cleanup + re-raise pattern, must catch all to clean port reservation
            logger.error("Failed to spawn external OI server", exc_info=True, extra={"chat_id": chat_id, "port": port, "error": str(e)})
            # Clear reservation on failure.
            async with self._lock:
                self._ports_in_use.pop(port, None)
            raise

        # Phase 3: publish under lock (handle race where something else created it).
        async with self._lock:
            # If someone else already created one, stop the new one (should be rare).
            current = self._servers.get(chat_id)
            if current and self._is_alive(current):
                await self._terminate_process(rec._proc)
                try:
                    if rec._log_fp:
                        rec._log_fp.close()
                except OSError:
                    pass
                self._ports_in_use.pop(port, None)
                current.last_used = time.time()
                return current, False

            self._servers[chat_id] = rec
            self._ports_in_use[port] = chat_id
            return rec, True

    async def touch(self, chat_id: str) -> None:
        async with self._lock:
            rec = self._servers.get(chat_id)
            if rec:
                rec.last_used = time.time()

    async def stop_server(self, chat_id: str) -> None:
        async with self._lock:
            await self._stop_locked(chat_id)

    async def stop_all(self) -> None:
        async with self._lock:
            for chat_id in list(self._servers.keys()):
                await self._stop_locked(chat_id)

    # -------------------------
    # Internal helpers (locked)
    # -------------------------

    async def _cleanup_stale_locked(self) -> None:
        now = time.time()
        stale = [
            chat_id
            for chat_id, rec in self._servers.items()
            if (now - float(rec.last_used)) > self._ttl_seconds
        ]
        for chat_id in stale:
            await self._stop_locked(chat_id)

    async def _evict_lru_locked(self) -> None:
        if not self._servers:
            return
        lru_chat_id = min(self._servers.items(), key=lambda kv: kv[1].last_used)[0]
        await self._stop_locked(lru_chat_id)

    def _allocate_port_locked(self) -> int:
        for port in range(self._port_min, self._port_max + 1):
            if port in self._ports_in_use:
                continue
            if self._is_port_free(port):
                return port
        raise RuntimeError(
            f"No free port available for OI server pool in range {self._port_min}-{self._port_max}"
        )

    async def _stop_locked(self, chat_id: str) -> None:
        rec = self._servers.pop(chat_id, None)
        if not rec:
            # Might still be reserved; clear reservations.
            for p, owner in list(self._ports_in_use.items()):
                if owner == chat_id or owner == f"__reserved__:{chat_id}":
                    self._ports_in_use.pop(p, None)
            return

        self._ports_in_use.pop(rec.port, None)
        try:
            await self._terminate_process(rec._proc)
        finally:
            try:
                if rec._log_fp:
                    rec._log_fp.close()
            except OSError:
                pass
            # Remove readiness sentinel for this port.
            try:
                sentinel = Path(self._logs_dir) / f"oi-server-{rec.port}.ready"
                if sentinel.exists():
                    sentinel.unlink()
            except OSError:
                pass

    def _is_alive(self, rec: ExternalOIServerRecord) -> bool:
        try:
            return rec._proc.poll() is None
        except (OSError, AttributeError) as e:
            logger.debug("Error checking OI server process health for chat %s: %s", rec.chat_id, e)
            return False

    @staticmethod
    def _is_port_free(port: int) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("127.0.0.1", int(port)))
                return True
        except OSError:
            return False

    async def _spawn_and_wait(self, *, chat_id: str, port: int) -> ExternalOIServerRecord:
        http_url = f"{self._scheme_http}://{self._host}:{port}"
        ws_url = f"{self._scheme_ws}://{self._host}:{port}/"

        log_path = Path(self._logs_dir) / f"oi-server-chat-{chat_id[:8]}-{port}.log"
        log_fp = open(log_path, "ab", buffering=0)

        import sys
        
        cmd = []
        if sys.platform == "darwin":
            from config.settings import get_settings
            settings = get_settings()
            # Try to locate the sandbox profile
            sandbox_profile = settings.app_root / "config" / "oi-sandbox.sb"
            if sandbox_profile.exists():
                local_env = settings.app_root / "config" / "local.env"
                if not local_env.exists():
                    local_env = settings.app_root / "local.env"
                ssh_dir = Path.home() / ".ssh"
                
                cmd.extend([
                    "sandbox-exec",
                    "-D", f"LOCAL_ENV_PATH={local_env.resolve()}",
                    "-D", f"SSH_DIR={ssh_dir.resolve()}",
                    "-D", f"SANDBOX_PROFILE_PATH={sandbox_profile.resolve()}",
                    "-f", str(sandbox_profile.resolve())
                ])
                
        cmd.extend([
            self._venv_python,
            self._wrapper_script,
            "--host",
            self._host,
            "--port",
            str(port),
            "--backend-url",
            self._backend_url,
            "--chat-id",
            chat_id,
        ])
        if self._auth_token:
            cmd.append(f"--auth={self._auth_token}")

        env = os.environ.copy()
        env.setdefault("AETHER_BACKEND_URL", self._backend_url)
        env["AETHER_LOGS_DIR"] = self._logs_dir

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=log_fp,
                stderr=log_fp,
                env=env,
                start_new_session=True,
            )
        finally:
            try:
                log_fp.close()
            except OSError:
                pass

        try:
            await self._wait_healthy(http_url, port=port, proc=proc)
        except Exception as e:  # noqa: BLE001 -- cleanup + re-raise, must catch all to terminate process
            logger.error("OI server failed to become healthy", exc_info=True, extra={"chat_id": chat_id, "port": port, "error": str(e)})
            await self._terminate_process(proc)
            raise

        rec = ExternalOIServerRecord(
            chat_id=chat_id,
            host=self._host,
            port=port,
            http_url=http_url,
            ws_url=ws_url,
            pid=int(proc.pid),
            started_at=time.time(),
            last_used=time.time(),
            _proc=proc,
            _log_fp=None,
        )
        logger.info("✅ Spawned per-chat OI server", extra={"chat_id": chat_id, "port": port, "pid": rec.pid})
        return rec

    async def _wait_healthy(
        self,
        http_url: str,
        *,
        port: int = 0,
        proc: Optional[subprocess.Popen] = None,
    ) -> None:
        """
        Wait for the OI server to be fully initialized.

        Two-phase readiness:
        1. Heartbeat endpoint responds (uvicorn is up)
        2. Wrapper readiness sentinel file exists (settings + tools applied)

        Phase 2 prevents the backend from sending WS messages while the wrapper
        is still applying settings or registering tools.

        Early death detection: if ``proc`` is provided, each iteration checks
        whether the process has already exited.  When the server crashes on
        startup (e.g. import error), this prevents a 30-second dead wait and
        surfaces the real error immediately.
        """
        heartbeat = http_url.rstrip("/") + "/heartbeat"
        deadline = time.time() + self._startup_timeout_seconds

        # Phase 1: heartbeat (server process is accepting HTTP).
        async with httpx.AsyncClient(timeout=2.0) as client:
            while time.time() < deadline:
                # Early death detection: if the process already exited, stop waiting.
                if proc is not None and proc.poll() is not None:
                    raise RuntimeError(
                        f"OI server process exited prematurely (exit code {proc.returncode}). "
                        f"Check OI server log for details."
                    )
                try:
                    r = await client.get(heartbeat)
                    if r.status_code < 400:
                        break
                except Exception:  # noqa: BLE001 — startup probe retry loop
                    pass
                await asyncio.sleep(0.1)  # More reactive polling (10Hz)
            else:
                raise RuntimeError(f"OI server did not become healthy in time: {heartbeat}")

        # Phase 2: wrapper readiness sentinel (settings + tools applied).
        # Separate deadline: phase 1 may consume most of the shared budget,
        # leaving phase 2 with near-zero time.  Give sentinel its own window.
        if port > 0:
            sentinel = Path(self._logs_dir) / f"oi-server-{port}.ready"
            sentinel_deadline = time.time() + min(self._startup_timeout_seconds, 30.0)
            while time.time() < sentinel_deadline:
                if proc is not None and proc.poll() is not None:
                    raise RuntimeError(
                        f"OI server process exited during initialization (exit code {proc.returncode}). "
                        f"Check OI server log for details."
                    )
                if sentinel.exists():
                    logger.debug("OI wrapper readiness sentinel found: %s", sentinel)
                    return
                await asyncio.sleep(0.1)  # More reactive polling (10Hz)
            # If sentinel never appeared, log a warning but proceed anyway (wrapper might be
            # a packaged build without OIToolCatalogBridge, which skips tool injection quickly).
            logger.warning(
                "OI wrapper readiness sentinel not found within timeout (port=%d), proceeding anyway",
                port,
            )
        # If no port provided, just heartbeat is sufficient.

    async def _terminate_process(self, proc: subprocess.Popen) -> None:
        # Graceful stop: terminate the whole process group if possible.
        try:
            if proc.poll() is not None:
                return
        except (OSError, ProcessLookupError, PermissionError):
            return

        pid = int(proc.pid)
        try:
            try:
                os.killpg(pid, signal.SIGTERM)
            except (OSError, ProcessLookupError, PermissionError) as e:
                logger.debug("Failed to SIGTERM OI server process group %d: %s", pid, e)
                proc.terminate()
        except (OSError, ProcessLookupError, PermissionError) as e:
            logger.debug("Failed to terminate OI server process %d: %s", pid, e)

        # Wait briefly, then hard-kill.
        end = time.time() + 2.0
        while time.time() < end:
            try:
                if proc.poll() is not None:
                    return
            except (OSError, ProcessLookupError, PermissionError):
                return
            await asyncio.sleep(0.1)

        try:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (OSError, ProcessLookupError, PermissionError) as e:
                logger.debug("Failed to SIGKILL OI server process group %d: %s", pid, e)
                proc.kill()
        except (OSError, ProcessLookupError, PermissionError) as e:
            logger.debug("Failed to kill OI server process %d: %s", pid, e)

