"""
Job Worker Health Monitoring Watchdog

Runtime worker that supervises background job worker health and lifecycle.
Restarts worker on failures, code changes, and logs events to database.

@.architecture
Incoming: config/settings.py, workers/__main__.py --- {Settings, subprocess}
Processing: check_worker_health(), launch_worker(), watch_code_changes() --- {3 jobs: JOB_HEALTH_CHECK, JOB_MANAGE_TASK, JOB_LOG}
Outgoing: monitoring/logging.py, data/database/repositories/health.py --- {health_status, log_events}
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import subprocess
import sys
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Optional

from watchfiles import awatch, Change

from config.settings import get_settings, get_app_root
from data.database.clients.supabase import SupabaseClient
from data.database.persistence_gateway import SupabasePersistenceGateway
from data.database.repositories.health import HealthRepository

logger = logging.getLogger("jobs.worker_watchdog")


def _get_log_dir() -> Path:
    """
    Get the canonical log directory — must match start_production.sh LOG_DIR.

    Uses get_app_root() (which respects AETHER_BACKEND_ROOT env var set by
    the shell script) so the PID file lands in the same place the shell
    expects it.  Fixes orphan-watchdog leak caused by PID-file path mismatch.
    """
    return get_app_root() / "logs"


BACKEND_ROOT = get_app_root()
PID_FILE = _get_log_dir() / "worker_watchdog.pid"


def _pid_is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def ensure_single_instance(pid_file: Path) -> None:
    """
    Ensure only one job worker watchdog instance runs at a time.
    Prevents duplicate watchdogs from spawning multiple workers.
    """
    try:
        if pid_file.exists():
            raw = pid_file.read_text().strip()
            if raw.isdigit():
                existing_pid = int(raw)
                if existing_pid != os.getpid() and _pid_is_running(existing_pid):
                    logger.warning("Job worker watchdog already running (pid=%s). Exiting.", existing_pid)
                    raise SystemExit(0)
    except Exception as e:
        logger.debug("Failed to read pid file: %s", e)

    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()))


async def check_worker_health(proc: Optional[subprocess.Popen]) -> bool:
    """Check if worker process is alive and responsive."""
    if not proc:
        return False

    # Check if process is still running
    return_code = proc.poll()
    if return_code is not None:
        logger.warning("Worker process terminated with code %s", return_code)
        return False

    return True


def launch_worker(settings) -> tuple[subprocess.Popen, Optional[Path]]:
    """Launch background job worker process."""
    is_frozen = getattr(sys, 'frozen', False)
    
    # Check for workers module directory only in development
    if not is_frozen:
        workers_module = (BACKEND_ROOT / "workers").resolve()
        if not workers_module.exists():
            raise FileNotFoundError(f"Workers module not found at {workers_module}")

    log_path = BACKEND_ROOT / "logs" / "worker-dev.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = open(log_path, "a", buffering=1)

    # Detect frozen environment (packaged binary) vs source environment
    if is_frozen:
        # sys.executable is the aether-hub binary itself
        cmd = [sys.executable, "worker"]
    else:
        # sys.executable is the python interpreter, we need to point to main.py
        main_py = BACKEND_ROOT / "main.py"
        cmd = [sys.executable, str(main_py), "worker"]

    logger.info("Starting background job worker (aether-hub worker)")
    logger.info("Command: %s", " ".join(cmd))
    
    # Clean environment for child process to avoid PyInstaller inheritance issues
    child_env = os.environ.copy()
    if is_frozen:
        # Remove variables that might confuse the child PyInstaller process
        # This is CRITICAL to prevent "encodings" module errors in children
        for var in ["PYTHONPATH", "PYTHONHOME", "PYTHONIOENCODING", "PYTHONUTF8"]:
            child_env.pop(var, None)
    
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(BACKEND_ROOT),
            stdout=log_file,
            stderr=log_file,
            env={**child_env, "PYTHONUNBUFFERED": "1"},
            start_new_session=True,
        )
    finally:
        try:
            log_file.close()
        except Exception as e:
            logger.debug("Failed to close log file after subprocess launch: %s", e)

    logger.info("Worker process started with PID %s", proc.pid)
    
    # Persist PID for API health checks
    pid_file = BACKEND_ROOT / "logs" / "worker.pid"
    try:
        pid_file.write_text(str(proc.pid))
    except Exception as e:
        logger.warning("Failed to write worker PID file: %s", e)
        
    return proc, log_path


def stop_process(proc: Optional[subprocess.Popen], log_path: Optional[Path]) -> None:
    """Gracefully stop worker process."""
    if proc and proc.poll() is None:
        logger.info("Stopping worker process (pid=%s)", proc.pid)
        try:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=10)
            logger.info("Worker process terminated gracefully")
        except subprocess.TimeoutExpired:
            logger.warning("Worker did not stop gracefully, killing...")
            proc.kill()
            proc.wait()
        except Exception as e:
            logger.error("Error stopping worker: %s", e)
            try:
                proc.kill()
            except Exception as e:
                logger.debug("Failed to kill worker process: %s", e)

    if proc:
        for stream in (proc.stdout, proc.stderr):
            if stream:
                try:
                    stream.close()
                except Exception as e:
                    logger.debug("Failed to close stream for worker process: %s", e)

    if log_path:
        try:
            logger.debug("Worker log persisted at %s", log_path)
        except Exception as e:
            logger.debug("Failed to access log path for worker process: %s", e)


async def initialize_gateway(settings) -> Optional[SupabasePersistenceGateway]:
    """Initialize Supabase gateway for health logging."""
    if not settings.supabase.enabled:
        return None
    try:
        client = SupabaseClient.from_env(
            {
                "url": settings.supabase.url,
                "anon_key": settings.supabase.anon_key,
                "service_role_key": settings.supabase.service_role_key,
                "schema": settings.supabase.db_schema,
                "realtime_enabled": settings.supabase.realtime_enabled,
            }
        )
        await client.initialize()
        return SupabasePersistenceGateway(client)
    except Exception as exc:
        logger.warning("Supabase unavailable for worker health tracking: %s", exc)
        return None


async def watchdog_loop(health_interval: float = 30.0, watch_code: bool = True) -> None:
    """
    Main watchdog loop.

    Monitors worker health and optionally watches for code changes.
    Restarts worker on failure or code change.
    """
    settings = get_settings()

    process: Optional[subprocess.Popen] = None
    log_path: Optional[Path] = None
    gateway = await initialize_gateway(settings)
    health_repo = HealthRepository(gateway) if gateway else None
    restart_lock = asyncio.Lock()
    stop_event = asyncio.Event()

    # Get running loop for signal handling
    loop = asyncio.get_running_loop()
    
    def signal_handler():
        logger.info("Received shutdown signal, stopping watchdog...")
        stop_event.set()

    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, signal_handler)
    except NotImplementedError:
        # Fallback for Windows
        def win_signal_handler(sig, frame):
            logger.info("Received signal %s, stopping...", sig)
            stop_event.set()
        signal.signal(signal.SIGINT, win_signal_handler)
        signal.signal(signal.SIGTERM, win_signal_handler)

    # Paths to watch for code changes
    is_frozen = getattr(sys, 'frozen', False)
    watch_paths = []
    
    if not is_frozen:
        watch_paths = [
            settings.config_dir.parent / "workers",
            settings.config_dir.parent / "application" / "agents",
            settings.config_dir.parent / "services" / "agents",  # Agent services (prompts, aether_rag_manager, etc.)
        ]
        watch_paths = [p for p in watch_paths if p.exists()]

    logger.info("Worker watchdog started (health_interval=%ss, watch_code=%s)", health_interval, watch_code)
    if not is_frozen and watch_code and watch_paths:
        logger.info("Watching for code changes in: %s", [str(p) for p in watch_paths])
    elif is_frozen:
        logger.info("Code watching disabled in production (frozen binary)")
        watch_code = False

    async def _record_health(status: str, error: Optional[str] = None, metadata: Optional[dict] = None) -> None:
        """
        Record health in integration_health table.
        NOTE: integration_health.status is constrained to: healthy|degraded|unhealthy|unknown.
        """
        if not health_repo:
            return
        await health_repo.record_integration_health("job_worker", status, error, metadata)

    async def _restart_worker(reason: str, error: Optional[str] = None) -> None:
        """Restart the worker process (serialized by lock to prevent double-spawn)."""
        nonlocal process, log_path
        async with restart_lock:
            if stop_event.is_set():
                return
            stop_process(process, log_path)
            await asyncio.sleep(1)
            try:
                process, log_path = launch_worker(settings)
                await _record_health(
                    "degraded",
                    None,
                    {"watchdog": "job_worker", "event": "restarted", "reason": reason},
                )
                logger.info("✅ Worker restarted successfully (%s)", reason)
            except Exception as exc:
                process = None
                log_path = None
                await _record_health(
                    "unhealthy",
                    str(exc),
                    {"watchdog": "job_worker", "event": "restart_failed", "reason": reason},
                )
                logger.error("Failed to restart worker (%s): %s", reason, exc, exc_info=True)

    async def _health_loop() -> None:
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=health_interval)
                break # Event was set
            except asyncio.TimeoutError:
                pass # Timeout reached, run check

            healthy = await check_worker_health(process)
            if healthy:
                logger.debug("Worker process healthy")
                await _record_health("healthy", None, {"watchdog": "job_worker", "status": "healthy"})
                continue

            if not stop_event.is_set():
                logger.error("Worker process unhealthy, restarting...")
                await _record_health(
                    "unhealthy",
                    "worker_process_not_running",
                    {"watchdog": "job_worker", "status": "unhealthy"},
                )
                await _restart_worker("unhealthy")

    async def _code_watch_loop() -> None:
        async for changes in awatch(*watch_paths):
            if stop_event.is_set():
                break
            python_changes = [(change_type, path) for change_type, path in changes if path.endswith(".py")]
            if not python_changes:
                continue

            logger.info("Code changes detected: %s Python file(s) modified", len(python_changes))
            for change_type, path in python_changes[:3]:
                logger.info("  %s: %s", Change(change_type).name, path)

            await _record_health(
                "degraded",
                None,
                {"watchdog": "job_worker", "event": "code_change", "files": [p for _, p in python_changes[:10]]},
            )
            await _restart_worker("code_change")

    async with AsyncExitStack():
        try:
            process, log_path = launch_worker(settings)
            await _record_health("healthy", None, {"watchdog": "job_worker", "event": "started"})

            tasks = [asyncio.create_task(_health_loop())]
            if watch_code and watch_paths:
                tasks.append(asyncio.create_task(_code_watch_loop()))

            # Wait for either completion (error) or stop event
            await stop_event.wait()
            
            # Cancel tasks
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        except asyncio.CancelledError:
            logger.info("Worker watchdog cancelled")
        except KeyboardInterrupt:
            logger.info("Worker watchdog interrupted by user")
        except Exception as e:
            logger.error("Worker watchdog error: %s", e, exc_info=True)
            await _record_health("unhealthy", str(e), {"watchdog": "job_worker", "event": "watchdog_error"})
        finally:
            logger.info("Stopping worker process...")
            stop_process(process, log_path)
            if gateway:
                try:
                    await gateway.dispose()
                except Exception as e:
                    logger.debug("Failed to dispose gateway during watchdog shutdown: %s", e)
            logger.info("Worker watchdog shutdown complete")


def configure_logging(verbose: bool = False) -> None:
    """Configure logging for watchdog."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s :: %(message)s",
    )


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description="Background job worker watchdog - monitors worker health and code changes.")
    parser.add_argument("--health-interval", type=float, default=30.0, help="Health check interval in seconds (default: 30)")
    parser.add_argument(
        "--watch-code",
        action="store_true",
        default=True,
        help="Watch for code changes and auto-restart (default: True)",
    )
    parser.add_argument("--no-watch-code", dest="watch_code", action="store_false", help="Disable code watching (health checks only)")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")
    return parser.parse_args()


def main() -> None:
    """Main entry point."""
    args = parse_args()
    configure_logging(verbose=args.verbose)
    ensure_single_instance(PID_FILE)

    logger.info("=" * 60)
    logger.info("Job Worker Watchdog Starting")
    logger.info("Health checks: every %ss", args.health_interval)
    logger.info("Code watching: %s", "enabled" if args.watch_code else "disabled")
    logger.info("=" * 60)

    try:
        asyncio.run(watchdog_loop(health_interval=args.health_interval, watch_code=args.watch_code))
    except KeyboardInterrupt:
        logger.info("Worker watchdog interrupted by user.")
    except Exception as e:
        logger.error("Worker watchdog failed: %s", e, exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()

