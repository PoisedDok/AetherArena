"""
Daemon control utilities for backend to manage daemon_manager lifecycle.
"""

import logging
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024  # 10MB
DEFAULT_DAEMON_LOG_BACKUP_COUNT = 3
_TRUTHY_ENV_VALUES = {"1", "true", "yes", "on"}


def _parse_positive_int(value: object, default: int, minimum: int = 1) -> int:
    """Parse positive integer values with fallback defaults."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, parsed)


def _rotate_log_if_needed(log_file: Path, *, max_bytes: int, backup_count: int) -> None:
    """Rotate daemon log on startup when file already exceeds bounded size."""
    try:
        if not log_file.exists() or log_file.stat().st_size < max_bytes:
            return
    except OSError:
        return

    # Shift backups: .N -> .N+1
    for idx in range(backup_count - 1, 0, -1):
        src = Path(f"{log_file}.{idx}")
        dst = Path(f"{log_file}.{idx + 1}")
        if src.exists():
            try:
                if dst.exists():
                    dst.unlink()
                src.rename(dst)
            except OSError:
                pass

    first_backup = Path(f"{log_file}.1")
    try:
        if first_backup.exists():
            first_backup.unlink()
        log_file.rename(first_backup)
    except OSError:
        # Non-fatal: if rotation fails, continue with append mode.
        pass


def is_onboarding_setup_mode() -> bool:
    """
    Return True when backend runs in first-run onboarding setup mode.

    start_production.sh sets AETHER_SKIP_SHELL_SETUP=true for frontend-managed
    first run. In this mode, daemon-manager must not be started/reloaded.
    """
    value = os.getenv("AETHER_SKIP_SHELL_SETUP", "")
    return value.strip().lower() in _TRUTHY_ENV_VALUES

def _get_writable_data_root() -> Path:
    """Resolve writable data root for PID files and logs.
    
    In production (frozen binary), Path(__file__) resolves inside the read-only
    _internal/ directory. Use AETHER_BACKEND_ROOT (set by start_production.sh
    to the writable ~/Library/Application Support/Aether/) instead.
    """
    backend_root = os.environ.get("AETHER_BACKEND_ROOT")
    if backend_root:
        return Path(backend_root)
    # Development fallback: repo root (3 levels up from services/daemons/daemon_control.py)
    return Path(__file__).parent.parent.parent

PID_FILE = _get_writable_data_root() / "data" / "runtime" / "daemon_manager.pid"
LOCK_FILE = _get_writable_data_root() / "data" / "runtime" / "daemon_manager.lock"
DAEMON_MANAGER_SCRIPT = Path(__file__).parent / "daemon_manager.py"


def is_daemon_manager_running() -> bool:
    """Check if daemon manager process is running and is actually our process."""
    try:
        # Check PID file first (fast path)
        if PID_FILE.exists():
            try:
                pid = int(PID_FILE.read_text().strip())
                if _is_verified_daemon_manager(pid):
                    return True
                # PID file exists but process is wrong/dead - clean up
                PID_FILE.unlink(missing_ok=True)
            except (ValueError, OSError):
                PID_FILE.unlink(missing_ok=True)

        # Fallback: check lock file (slow path for orphaned lock recovery)
        if LOCK_FILE.exists():
            try:
                # In daemon_manager.py, the lock file contains the PID
                lock_pid = int(LOCK_FILE.read_text().strip())
                if _is_verified_daemon_manager(lock_pid):
                    # Process is alive and holding the lock - rewrite PID file to adopt it
                    logger.info(f"Adopting daemon manager process from lock file (PID: {lock_pid})")
                    PID_FILE.write_text(str(lock_pid))
                    return True
            except (ValueError, OSError):
                pass

        return False
            
    except Exception as e:
        logger.warning(f"Error checking daemon manager status: {e}")
        return False


def _is_verified_daemon_manager(pid: int) -> bool:
    """Verify if a PID belongs to a running daemon manager instance."""
    try:
        os.kill(pid, 0)  # Existence check
        
        # Verify identity via cmdline inspection
        try:
            import psutil
            proc = psutil.Process(pid)
            cmdline = ' '.join(proc.cmdline())
            
            # Match both development (underscore) and production (hyphen) formats
            return 'daemon_manager' in cmdline or 'daemon-manager' in cmdline
        except ImportError:
            # psutil not available - trust existence if no other evidence
            return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False
            
    except OSError:
        return False


def get_daemon_manager_pid() -> Optional[int]:
    """Get daemon manager PID if running and verified."""
    try:
        # Check PID file
        if PID_FILE.exists():
            pid = int(PID_FILE.read_text().strip())
            if _is_verified_daemon_manager(pid):
                return pid
            PID_FILE.unlink(missing_ok=True)

        # Check Lock file
        if LOCK_FILE.exists():
            lock_pid = int(LOCK_FILE.read_text().strip())
            if _is_verified_daemon_manager(lock_pid):
                return lock_pid
                
        return None
    except Exception:
        return None


def start_daemon_manager() -> bool:
    """
    Start daemon manager as independent background process.
    
    NON-DESTRUCTIVE LIFECYCLE:
    - If a daemon-manager is already running, ADOPT it (return True).
    - If no daemon-manager is running, spawn a new one.
    - NEVER kills existing daemon-managers. The flock in daemon_manager.py
      is the singleton gate — even if we accidentally spawn a second process,
      it will exit immediately when it fails to acquire the lock.
    - Fully detached from parent (survives backend restarts).
    """
    try:
        # Check if daemon-manager is already running — adopt if so
        if is_daemon_manager_running():
            tracked_pid = get_daemon_manager_pid()
            logger.info(f"Daemon manager already running (PID: {tracked_pid}) — adopted")
            return True
        
        logger.info("Starting daemon manager...")
        
        # PRO-FIX: Redirect daemon logs to a file instead of DEVNULL
        # This allows us to debug why daemons might not be starting or failing.
        # Use writable data root (not __file__ which resolves to read-only _internal/ in production)
        log_dir = _get_writable_data_root() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / "daemons.log"
        max_bytes = _parse_positive_int(
            os.getenv("DAEMON_LOG_MAX_BYTES"),
            DEFAULT_DAEMON_LOG_MAX_BYTES,
            minimum=1024,
        )
        backup_count = _parse_positive_int(
            os.getenv("DAEMON_LOG_BACKUP_COUNT"),
            DEFAULT_DAEMON_LOG_BACKUP_COUNT,
        )
        _rotate_log_if_needed(log_file, max_bytes=max_bytes, backup_count=backup_count)
        
        # FROZEN BINARY FIX: In PyInstaller builds, sys.executable is the frozen
        # binary (aether-hub), not python3. Use the binary's daemon-manager
        # subcommand instead of trying to run daemon_manager.py as a script.
        is_frozen = getattr(sys, 'frozen', False)
        if is_frozen:
            cmd = [sys.executable, "daemon-manager"]
            cwd = str(Path(sys.executable).parent)
        else:
            cmd = [sys.executable, str(DAEMON_MANAGER_SCRIPT)]
            cwd = str(DAEMON_MANAGER_SCRIPT.parent)
        
        logger.info(f"Daemon manager launch: frozen={is_frozen}, cmd={cmd}")
        child_env = os.environ.copy()
        child_env.setdefault("DAEMON_LOG_MAX_BYTES", str(max_bytes))
        child_env.setdefault("DAEMON_LOG_BACKUP_COUNT", str(backup_count))
        # Keep stdout mirroring disabled by default when detached.
        child_env.setdefault("DAEMON_LOG_TO_STDOUT", "0")
        
        # CRITICAL: Use start_new_session + close_fds for complete detachment
        # This ensures daemon continues running after backend stops.
        # Open log file in a context-aware way: close in parent after Popen inherits it.
        log_fh = open(log_file, "a")
        try:
            process = subprocess.Popen(
                cmd,
                stdout=log_fh,
                stderr=log_fh,
                stdin=subprocess.DEVNULL,
                start_new_session=True,  # Creates new process group, detaches from terminal
                close_fds=True,          # Close all inherited file descriptors
                cwd=cwd,
                env=child_env,
            )
        finally:
            # Parent process must close its copy of the file handle.
            # The child process has its own independent copy via fd inheritance.
            log_fh.close()
        
        # Give daemon time to start and write PID file
        # Frozen binaries need more time due to decompression overhead
        # Python imports for AI libraries can also be slow in development
        import time
        initial_wait = 3.0 if is_frozen else 2.0
        time.sleep(initial_wait)
        
        # Verify startup with retry (handles PID file write delays)
        max_retries = 6 if is_frozen else 8
        retry_interval = 1.0 if is_frozen else 1.0
        for attempt in range(max_retries):
            if is_daemon_manager_running():
                pid = get_daemon_manager_pid()
                logger.info(f"✅ Daemon manager started (PID: {pid})")
                
                # Verify it's truly detached (PPID should be 1 or init process)
                try:
                    import psutil
                    proc = psutil.Process(pid)
                    ppid = proc.ppid()
                    if ppid != 1:
                        logger.warning(f"⚠️  Daemon manager PPID={ppid} (expected 1 for full detachment)")
                    else:
                        logger.info("✅ Daemon manager fully detached (PPID=1)")
                except Exception:
                    pass
                
                return True
            
            if attempt < max_retries - 1:
                logger.debug(f"Daemon manager not ready, retrying... ({attempt + 1}/{max_retries})")
                time.sleep(retry_interval)
        
        total_wait = initial_wait + (max_retries - 1) * retry_interval
        logger.error(f"❌ Daemon manager failed to start (PID file not found after {total_wait:.0f}s)")
        return False
            
    except Exception as e:
        logger.error(f"Failed to start daemon manager: {e}", exc_info=True)
        return False


def stop_daemon_manager() -> bool:
    """Stop daemon manager gracefully."""
    try:
        pid = get_daemon_manager_pid()
        if not pid:
            logger.info("Daemon manager not running")
            return True
        
        logger.info(f"Stopping daemon manager (PID: {pid})...")
        
        # Send SIGTERM for graceful shutdown
        os.kill(pid, signal.SIGTERM)
        
        # Wait for shutdown
        import time
        for _ in range(10):  # Wait up to 10 seconds
            time.sleep(1)
            if not is_daemon_manager_running():
                logger.info("✅ Daemon manager stopped")
                return True
        
        # Force kill if still running
        if is_daemon_manager_running():
            logger.warning("Force killing daemon manager...")
            os.kill(pid, signal.SIGKILL)
            time.sleep(1)
        
        return not is_daemon_manager_running()
        
    except Exception as e:
        logger.error(f"Failed to stop daemon manager: {e}", exc_info=True)
        return False


def reload_daemon_manager() -> bool:
    """Signal daemon manager to reload config and restart daemons."""
    try:
        if is_onboarding_setup_mode():
            logger.info("Onboarding setup mode active; skipping daemon-manager reload")
            return True

        pid = get_daemon_manager_pid()
        if not pid:
            logger.warning("Daemon manager not running, starting it...")
            return start_daemon_manager()
        
        logger.info(f"Reloading daemon manager (PID: {pid})...")
        
        # Send SIGHUP to trigger reload
        os.kill(pid, signal.SIGHUP)
        
        logger.info("✅ Reload signal sent")
        return True
        
    except Exception as e:
        logger.error(f"Failed to reload daemon manager: {e}", exc_info=True)
        return False


def _any_runtime_daemons_enabled(runtime_cfg) -> bool:
    """Return True when at least one Phase-1 daemon is enabled in runtime config."""
    return bool(
        runtime_cfg.browser_enabled
        or runtime_cfg.email_enabled
        or runtime_cfg.file_system_enabled
        or runtime_cfg.query_generation_enabled
        or runtime_cfg.file_indexing_enabled
    )


async def ensure_daemon_manager_healthy(settings) -> bool:
    """
    Lightweight daemon-manager supervisor check (no forced reload).

    Use this in periodic health loops where forcing SIGHUP on every cycle would
    create unnecessary restarts. It only reconciles process liveness with runtime
    config intent.
    """
    try:
        import asyncio
        from config.proactive_config_reader import read_proactive_config

        if is_onboarding_setup_mode():
            if is_daemon_manager_running():
                logger.info("Onboarding setup mode active; stopping daemon manager")
                return await asyncio.to_thread(stop_daemon_manager)
            return True

        runtime_cfg = read_proactive_config(settings)

        should_run = runtime_cfg.enabled and _any_runtime_daemons_enabled(runtime_cfg)
        manager_running = is_daemon_manager_running()

        if should_run:
            if manager_running:
                return True

            logger.warning(
                "Daemon manager is down while proactive daemons are enabled; attempting restart..."
            )
            return await asyncio.to_thread(start_daemon_manager)

        # Proactive disabled or all daemon toggles off: ensure manager is not left idle.
        if manager_running:
            logger.info("Daemon manager running while proactive daemons disabled; stopping it")
            return await asyncio.to_thread(stop_daemon_manager)

        return True

    except Exception as e:
        logger.error(f"Failed daemon-manager health reconciliation: {e}", exc_info=True)
        return False


async def ensure_daemons_running(settings) -> bool:
    """
    Ensure daemon manager is running if any daemons are enabled in config.
    Called by backend on startup.
    
    ROBUST LIFECYCLE: Verifies process identity, not just PID existence.
    
    EVENT LOOP SAFETY: start_daemon_manager() and stop_daemon_manager() are
    blocking sync functions (they use time.sleep for process readiness checks).
    We offload them to a thread via asyncio.to_thread() so the FastAPI event
    loop is never blocked during daemon startup/shutdown.
    """
    try:
        import asyncio
        from config.proactive_config_reader import read_proactive_config

        if is_onboarding_setup_mode():
            logger.info("Onboarding setup mode active; skipping proactive daemon-manager startup")
            if is_daemon_manager_running():
                await asyncio.to_thread(stop_daemon_manager)
                logger.info("Stopped daemon manager while in onboarding setup mode")
            return True

        # Unified config reader (D3 fix): single source of truth with
        # consistent fallback chain for all consumers.
        runtime_cfg = read_proactive_config(settings)

        if not runtime_cfg.enabled:
            logger.info("Proactive system disabled via runtime config")
            if is_daemon_manager_running():
                logger.info("Stopping idle daemon manager...")
                await asyncio.to_thread(stop_daemon_manager)
            return True

        # Check if any daemons should be running (all 5 unified daemons)
        # Uses runtime_cfg (not settings) so PATCH /config toggles take effect.
        any_enabled = _any_runtime_daemons_enabled(runtime_cfg)
        
        if not any_enabled:
            logger.info("No proactive daemons enabled in config")
            return True
        
        # Check if daemon manager is running (with process verification)
        if is_daemon_manager_running():
            pid = get_daemon_manager_pid()
            logger.info(f"Daemon manager verified running (PID: {pid})")
            # Reload to ensure config sync
            reload_success = reload_daemon_manager()
            
            # Verify reload actually worked (non-blocking wait)
            await asyncio.sleep(2)
            if not is_daemon_manager_running():
                logger.warning("Daemon manager died during reload, restarting...")
                return await asyncio.to_thread(start_daemon_manager)
            
            return reload_success
        else:
            # Start daemon manager (no valid process found)
            logger.info("Starting daemon manager...")
            return await asyncio.to_thread(start_daemon_manager)
            
    except Exception as e:
        logger.error(f"Failed to ensure daemons running: {e}", exc_info=True)
        return False
