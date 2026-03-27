#!/usr/bin/env python3
"""
Standalone daemon manager - runs Phase 1 proactive daemons as independent processes.
These daemons run continuously, independent of FastAPI backend lifecycle.

Architecture:
- Runs as separate process with PID file for lifecycle management
- Watches config file for changes and reloads daemons dynamically
- Backend can start/stop/reload this manager via signals
- Daemons continue running even if backend stops
"""

import asyncio
import fcntl
import logging
import os
import signal
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import List, Optional

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from config.settings import get_settings
from core.system.task_tracker import TaskTracker
from services.daemons.browser.daemon import BrowserDaemon
from services.daemons.browser.config import BrowserDaemonConfig
from services.daemons.email.daemon import EmailDaemon
from services.daemons.email.config import EmailDaemonConfig
from services.daemons.filesystem.daemon import FileSystemDaemon
from services.daemons.filesystem.config import FileSystemDaemonConfig
from services.daemons.query_generation.daemon import QueryGenerationDaemon
from services.daemons.query_generation.config import QueryGenerationDaemonConfig
from services.daemons.file_indexing.daemon import FileIndexingDaemon
from services.daemons.file_indexing.config import IndexingServiceConfig

# PID file for process management.
# In production (frozen binary), Path(__file__) resolves inside the read-only
# _internal/ directory. Use AETHER_BACKEND_ROOT (writable data dir) when set.
def _writable_root() -> Path:
    backend_root = os.environ.get("AETHER_BACKEND_ROOT")
    if backend_root:
        return Path(backend_root)
    return Path(__file__).parent.parent.parent

PID_FILE = _writable_root() / "data" / "runtime" / "daemon_manager.pid"
# Lock file for singleton enforcement via flock.
# Separate from PID file so PID reads never block on the lock.
LOCK_FILE = _writable_root() / "data" / "runtime" / "daemon_manager.lock"
CONFIG_WATCH_INTERVAL = 5  # Check config every 5s

DEFAULT_DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024  # 10MB
DEFAULT_DAEMON_LOG_BACKUP_COUNT = 3
DEFAULT_RESTART_BASE_SECONDS = 10
DEFAULT_RESTART_MAX_SECONDS = 300
DEFAULT_RESTART_MAX_RETRIES = 5
DEFAULT_RESTART_RESET_AFTER_SECONDS = 300


def _parse_positive_int(value: object, default: int, minimum: int = 1) -> int:
    """Safely parse positive integer values with bounded fallback."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, parsed)


def _configure_daemon_manager_logging() -> Path:
    """Configure daemon-manager root logging with bounded file rotation.

    Uses a canonical writable log path for both development and packaged builds:
    {AETHER_BACKEND_ROOT or repo_root}/logs/daemons.log
    """
    log_dir = _writable_root() / "logs"
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
    log_level = os.getenv("DAEMON_LOG_LEVEL", "INFO").upper()
    level_value = getattr(logging, log_level, logging.INFO)

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)-30s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root_logger = logging.getLogger()
    root_logger.setLevel(level_value)
    root_logger.handlers = []

    rotating_handler = RotatingFileHandler(
        log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    rotating_handler.setFormatter(formatter)

    # Proactively roll oversized files at startup to cap historical growth.
    if log_file.exists():
        try:
            if log_file.stat().st_size >= max_bytes:
                rotating_handler.doRollover()
        except OSError:
            pass

    root_logger.addHandler(rotating_handler)

    # Optional stdout mirroring for foreground debugging only.
    if os.getenv("DAEMON_LOG_TO_STDOUT", "").strip().lower() in {"1", "true", "yes", "on"}:
        stream_handler = logging.StreamHandler(sys.stdout)
        stream_handler.setFormatter(formatter)
        root_logger.addHandler(stream_handler)

    return log_file


_DAEMON_LOG_FILE = _configure_daemon_manager_logging()
logger = logging.getLogger("daemon_manager")


class DaemonManager:
    """Manages lifecycle of all Phase 1 proactive daemons.
    
    Lifecycle:
    - start_all() → writes PID, starts daemons, enters management loop
    - stop_all() → gracefully stops all daemons and cleans up
    - _stop_daemons() → stops daemons only (used during reload, does NOT set running=False)
    - Reload: _stop_daemons() → _start_daemons() (manager stays alive)
    """
    
    def __init__(self):
        self.settings = get_settings()
        self.daemons: List[tuple[str, any]] = []
        self._daemon_tasks: dict[str, asyncio.Task] = {}  # Track daemon asyncio tasks for crash detection
        self._config_watcher_task: Optional[asyncio.Task] = None  # Track config watcher for cleanup
        self._lock_fd = None  # File descriptor for singleton flock — held for process lifetime
        self.running = True
        self._is_disposed = False
        self._stopping_daemons = False  # True during _stop_daemons to suppress done-callback restarts
        self.reload_requested = False
        self.last_config_check = time.time()
        self.config_state = self._get_config_state()
        self._daemon_start_times: dict[str, float] = {}  # monotonic-ish start timestamps for runtime stability checks
        self._restart_failures: dict[str, int] = {}
        self._task_tracker = TaskTracker()  # consecutive crash count per daemon

        daemons_cfg = getattr(self.settings.proactive, "daemons", None)
        self._restart_base_seconds = _parse_positive_int(
            os.getenv("DAEMON_RESTART_BASE_SECONDS"),
            _parse_positive_int(
                getattr(daemons_cfg, "supervisor_restart_base_seconds", None),
                DEFAULT_RESTART_BASE_SECONDS,
            ),
        )
        self._restart_max_seconds = _parse_positive_int(
            os.getenv("DAEMON_RESTART_MAX_SECONDS"),
            _parse_positive_int(
                getattr(daemons_cfg, "supervisor_restart_max_seconds", None),
                DEFAULT_RESTART_MAX_SECONDS,
            ),
        )
        self._restart_max_retries = _parse_positive_int(
            os.getenv("DAEMON_RESTART_MAX_RETRIES"),
            _parse_positive_int(
                getattr(daemons_cfg, "supervisor_restart_max_retries", None),
                DEFAULT_RESTART_MAX_RETRIES,
            ),
        )
        self._restart_reset_after_seconds = _parse_positive_int(
            os.getenv("DAEMON_RESTART_RESET_AFTER_SECONDS"),
            _parse_positive_int(
                getattr(daemons_cfg, "supervisor_restart_reset_after_seconds", None),
                DEFAULT_RESTART_RESET_AFTER_SECONDS,
            ),
        )
        
        # Ensure runtime directory exists
        PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        logger.info(
            "Daemon manager initialized (log=%s, restart policy: base=%ss max=%ss retries=%s reset_after=%ss)",
            _DAEMON_LOG_FILE,
            self._restart_base_seconds,
            self._restart_max_seconds,
            self._restart_max_retries,
            self._restart_reset_after_seconds,
        )
    
    def _get_config_state(self) -> dict:
        """Get current daemon configuration state for change detection.

        Uses unified ProactiveConfigReader (D3 fix) so daemon toggles from
        the PATCH /config endpoint are respected (previously read from stale
        in-memory settings only).
        """
        try:
            from config.proactive_config_reader import read_proactive_config
            cfg = read_proactive_config(self.settings)

            if not cfg.enabled:
                return {'enabled': False}

            return {
                'enabled': True,
                'browser_enabled': cfg.browser_enabled,
                'email_enabled': cfg.email_enabled,
                'file_system_enabled': cfg.file_system_enabled,
                'query_generation_enabled': cfg.query_generation_enabled,
                'file_indexing_enabled': cfg.file_indexing_enabled,
            }
        except Exception as e:
            logger.error(f"Error getting config state: {e}")
            return {}

    def _acquire_singleton_lock(self) -> bool:
        """Acquire an exclusive flock on LOCK_FILE to guarantee singleton.

        The lock is held for the entire process lifetime via self._lock_fd.
        If another daemon-manager already holds the lock, this returns False
        immediately (LOCK_NB = non-blocking). The OS releases the lock
        automatically on process exit/crash — no stale-lock cleanup needed.

        Returns True if lock acquired, False if another instance holds it.
        """
        try:
            # Open in append mode so we don't truncate a lock file owned by another process.
            self._lock_fd = open(LOCK_FILE, "a")
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            
            # Now we have the lock, safely truncate and write our PID
            self._lock_fd.truncate(0)
            self._lock_fd.write(str(os.getpid()))
            self._lock_fd.flush()
            return True
        except OSError:
            # Another daemon-manager holds the lock
            if self._lock_fd:
                self._lock_fd.close()
                self._lock_fd = None
            return False

    def _write_pid(self):
        """Write PID file for external process detection.

        Called AFTER _acquire_singleton_lock succeeds.
        The PID file is the public interface for daemon_control.py to find us.
        The lock file is the private mechanism preventing duplicates.
        """
        try:
            PID_FILE.write_text(str(os.getpid()))
            logger.info(f"PID file written: {PID_FILE} (PID: {os.getpid()})")
        except Exception as e:
            logger.error(f"Failed to write PID file: {e}")

    def _remove_pid(self):
        """Remove PID file and release singleton lock on shutdown.
        
        Only removes the PID file if this process successfully acquired the lock.
        """
        if not self._lock_fd:
            return  # We don't own the lock, so we shouldn't delete the PID file

        try:
            if PID_FILE.exists():
                PID_FILE.unlink()
                logger.info("PID file removed")
        except Exception as e:
            logger.error(f"Failed to remove PID file: {e}")

        # Release flock — allows a new daemon-manager to start
        try:
            fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            self._lock_fd.close()
            self._lock_fd = None
        except Exception as e:
            logger.error(f"Failed to release singleton lock: {e}")

    async def _watch_config(self):
        """Watch config for changes and trigger reload."""
        while self.running:
            try:
                await asyncio.sleep(CONFIG_WATCH_INTERVAL)
                
                # Reload settings and check runtime config
                self.settings = get_settings()
                new_config_state = self._get_config_state()
                
                if new_config_state != self.config_state:
                    logger.info("🔄 Config changed, reloading daemons...")
                    logger.info(f"   Old: {self.config_state}")
                    logger.info(f"   New: {new_config_state}")
                    self.config_state = new_config_state
                    self.reload_requested = True
            except Exception as e:
                logger.error(f"Config watch error: {e}")

    def _on_daemon_task_done(self, name: str, task: asyncio.Task):
        """Callback when a daemon task completes (crash detection).
        
        If a daemon task ends unexpectedly while the manager is still running,
        log the error and attempt restart after a cooldown.
        
        CRITICAL: Suppressed during _stop_daemons (reload path) to prevent
        duplicate daemon instances. The reload path will call _start_daemons
        which creates fresh instances — a concurrent restart would duplicate them.
        """
        self._daemon_tasks.pop(name, None)
        
        if not self.running:
            return  # Expected shutdown, not a crash
        
        if self._stopping_daemons:
            logger.debug(f"Daemon '{name}' task done during intentional stop — suppressing restart")
            return

        start_ts = self._daemon_start_times.pop(name, None)
        runtime_seconds = None
        if start_ts is not None:
            runtime_seconds = max(0, int(time.time() - start_ts))
        
        exc = task.exception() if not task.cancelled() else None
        if exc:
            logger.error(f"Daemon '{name}' crashed: {exc}", exc_info=exc)
        else:
            logger.warning(f"Daemon '{name}' exited unexpectedly (no exception)")

        delay = self._compute_restart_delay(name, runtime_seconds)
        if delay is None:
            # Remove stale crashed daemon reference when retries are exhausted.
            self.daemons = [(n, d) for n, d in self.daemons if n != name]
            return

        # Schedule restart with bounded exponential backoff to prevent crash loops.
        self._task_tracker.track_task(asyncio.create_task(self._restart_daemon(name, delay_seconds=delay)))
    
    def _compute_restart_delay(self, name: str, runtime_seconds: Optional[int]) -> Optional[int]:
        """Compute bounded exponential delay; return None when retry budget is exhausted."""
        if runtime_seconds is not None and runtime_seconds >= self._restart_reset_after_seconds:
            self._restart_failures.pop(name, None)

        failures = self._restart_failures.get(name, 0) + 1
        self._restart_failures[name] = failures

        if failures > self._restart_max_retries:
            logger.critical(
                "Daemon '%s' exceeded restart retry budget (%s). Leaving it stopped to break crash loop.",
                name,
                self._restart_max_retries,
            )
            return None

        delay = min(
            self._restart_base_seconds * (2 ** (failures - 1)),
            self._restart_max_seconds,
        )
        logger.warning(
            "Daemon '%s' restart attempt %s/%s in %ss (runtime=%ss)",
            name,
            failures,
            self._restart_max_retries,
            delay,
            runtime_seconds if runtime_seconds is not None else "unknown",
        )
        return int(delay)

    async def _restart_daemon(self, name: str, delay_seconds: Optional[int] = None):
        """Restart a single crashed daemon after cooldown.
        
        GUARD: If the daemon was already recreated (e.g., by a reload during the
        cooldown window), skip the restart to prevent duplicate instances.
        """
        cooldown = _parse_positive_int(delay_seconds, self._restart_base_seconds)
        logger.info(f"Restarting '{name}' daemon in {cooldown}s...")
        await asyncio.sleep(cooldown)
        
        if not self.running:
            return
        
        # Defense-in-depth: If daemon was already recreated by a reload, skip
        if name in self._daemon_tasks:
            logger.info(f"Daemon '{name}' already tracked (likely recreated by reload), skipping restart")
            return
        
        try:
            self.settings = get_settings()
            self.config_state = self._get_config_state()

            # Use the same registry as _start_daemons() — single definition of daemon metadata.
            registry = self._daemon_registry()

            entry = registry.get(name)
            if not entry:
                logger.error(f"Unknown daemon name for restart: {name}")
                return

            enabled, factory = entry
            if not enabled:
                logger.info(f"Daemon '{name}' is disabled in runtime config, skipping restart")
                return

            daemon_instance = factory()
            # Stop the old crashed daemon to release resources (e.g., watchdog Observer
            # threads in filesystem daemon). The dispose guard prevents double-stop.
            for old_name, old_daemon in self.daemons:
                if old_name == name:
                    try:
                        await old_daemon.stop()
                    except Exception as stop_err:
                        logger.warning(f"Failed to stop old '{name}' daemon instance: {stop_err}")
            # Remove stale reference from crashed daemon before appending new one
            self.daemons = [(n, d) for n, d in self.daemons if n != name]
            self.daemons.append((name, daemon_instance))
            task = self._task_tracker.track_task(asyncio.create_task(daemon_instance.start(), name=f"{name}_daemon"))
            self._daemon_tasks[name] = task
            self._daemon_start_times[name] = time.time()
            task.add_done_callback(lambda t, n=name: self._on_daemon_task_done(n, t))
            logger.info(f"Daemon '{name}' restarted successfully")
            
        except Exception as e:
            logger.error(f"Failed to restart daemon '{name}': {e}", exc_info=True)
    
    def _daemon_registry(self):
        """Build the daemon registry: name → (config_key, factory).

        Centralizes daemon metadata so _start_daemons and _restart_daemon use
        the same definitions. Factory returns (daemon_instance,) to match the
        existing _restart_daemon contract.
        """
        sd = self.settings.proactive.daemons
        return {
            'browser': (
                self.config_state.get('browser_enabled', sd.browser_enabled),
                lambda: BrowserDaemon(BrowserDaemonConfig.from_settings()),
            ),
            'email': (
                self.config_state.get('email_enabled', sd.email_enabled),
                lambda: EmailDaemon(EmailDaemonConfig.from_settings()),
            ),
            'filesystem': (
                self.config_state.get('file_system_enabled', sd.file_system_enabled),
                lambda: FileSystemDaemon(FileSystemDaemonConfig.from_settings()),
            ),
            'query_generation': (
                self.config_state.get('query_generation_enabled', sd.query_generation_enabled),
                lambda: QueryGenerationDaemon(QueryGenerationDaemonConfig.from_settings()),
            ),
            'file_indexing': (
                self.config_state.get('file_indexing_enabled', sd.file_indexing_enabled),
                lambda: FileIndexingDaemon(IndexingServiceConfig.from_env()),
            ),
        }

    async def _start_daemons(self):
        """Start all enabled daemons based on current runtime config.

        Clears stale daemon references before starting fresh.
        All daemon tasks are tracked for crash detection and cleanup.

        Per-daemon enabled checks use self.config_state (from ProactiveConfigReader),
        NOT self.settings.proactive.daemons. This ensures runtime changes via
        PATCH /v1/proactive/config (which writes to proactive_config.json) are
        respected on reload. The settings object only provides compile-time defaults.
        """
        # Check master switch (uses config_state — runtime config)
        if not self.config_state.get('enabled', True):
            logger.info("Proactive system disabled via runtime config - waiting...")
            return

        registry = self._daemon_registry()

        for name, (enabled, factory) in registry.items():
            if not enabled:
                continue
            try:
                daemon_instance = factory()
                self.daemons.append((name, daemon_instance))
                task = self._task_tracker.track_task(asyncio.create_task(daemon_instance.start(), name=f"{name}_daemon"))
                self._daemon_tasks[name] = task
                self._daemon_start_times[name] = time.time()
                # Fresh start path (startup or manual reload) should reset crash counters.
                self._restart_failures.pop(name, None)
                task.add_done_callback(lambda t, n=name: self._on_daemon_task_done(n, t))
                logger.info(f"{name.replace('_', ' ').title()} daemon started")
            except RuntimeError as e:
                # Singleton conflict — another instance running (e.g., query_generation from backend)
                logger.warning(f"Daemon '{name}' singleton conflict: {e}")
            except Exception as e:
                logger.error(f"Failed to start {name} daemon: {e}")

        if self.daemons:
            logger.info(f"Started {len(self.daemons)} Phase 1 daemons")
        else:
            logger.warning("No daemons enabled in configuration")
    
    async def _stop_daemons(self):
        """Stop all daemon instances WITHOUT setting self.running = False.
        
        Used during reload to stop daemons while keeping the manager alive.
        Cancels tracked tasks and clears daemon references.
        
        Sets _stopping_daemons flag to suppress done-callback restarts that
        would otherwise create duplicate daemon instances during reload.
        """
        logger.info("Stopping daemon instances...")
        self._stopping_daemons = True
        
        for name, daemon in self.daemons:
            try:
                await daemon.stop()
                logger.info(f"Stopped {name} daemon")
            except Exception as e:
                logger.error(f"Error stopping {name} daemon: {e}")
        
        # Cancel any tracked daemon tasks that didn't stop cleanly
        await self._task_tracker.cancel_all()
        for name, task in list(self._daemon_tasks.items()):
            if not task.done():
                task.cancel()
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=5.0)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass
        
        # Clear all daemon references (prevents stale accumulation on reload)
        self.daemons.clear()
        self._daemon_tasks.clear()
        self._daemon_start_times.clear()
        self._restart_failures.clear()
        self._stopping_daemons = False
        
        logger.info("All daemon instances stopped")
    
    async def start_all(self):
        """Start daemon manager with config watching.

        SINGLETON ENFORCEMENT: Acquires an exclusive flock before proceeding.
        If another daemon-manager already holds the lock, this method logs
        and returns immediately — no killing, no race conditions.
        """
        try:
            # SINGLETON GATE: Acquire exclusive flock before doing anything.
            # This is the ONLY mechanism that prevents duplicates. The PID file
            # check in __main__ is a fast-path optimization, not the authority.
            if not self._acquire_singleton_lock():
                logger.info("Another daemon-manager holds the singleton lock — exiting gracefully")
                return

            # Lock acquired — we are the sole daemon-manager. Write PID for external detection.
            self._write_pid()
            
            # Small delay to ensure PID file is flushed to disk
            await asyncio.sleep(0.1)
            
            # Start initial daemons
            await self._start_daemons()
            
            logger.info("Daemons running independently of backend")
            logger.info("Watching config for changes...")
            logger.info("Press Ctrl+C to stop all daemons")
            
            # Start config watcher (tracked for cleanup)
            self._config_watcher_task = self._task_tracker.track_task(asyncio.create_task(
                self._watch_config(), name="config_watcher"
            ))
            
            # Keep running and handle reload requests
            # CRITICAL: Reload calls _stop_daemons() (NOT stop_all()) to keep manager alive
            while self.running:
                if self.reload_requested:
                    logger.info("Processing reload request...")
                    await self._stop_daemons()
                    self.settings = get_settings()
                    self.config_state = self._get_config_state()
                    await self._start_daemons()
                    self.reload_requested = False
                    
                await asyncio.sleep(1)
                
        except Exception as e:
            logger.error(f"Failed to start daemons: {e}", exc_info=True)
            raise
        finally:
            self._remove_pid()
    
    async def stop_all(self):
        """Gracefully stop ALL managed resources (daemons + config watcher).
        
        Sets self.running = False, which exits the management loop.
        This is the FULL shutdown path -- use _stop_daemons() for reload.
        """
        if self._is_disposed:
            return
        
        logger.info("Stopping daemon manager (full shutdown)...")
        self.running = False
        self._is_disposed = True
        
        # Stop all daemon instances
        await self._stop_daemons()
        
        # Cancel config watcher task
        if self._config_watcher_task and not self._config_watcher_task.done():
            self._config_watcher_task.cancel()
            try:
                await asyncio.wait_for(
                    asyncio.shield(self._config_watcher_task), timeout=3.0
                )
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            self._config_watcher_task = None
        
        logger.info("Daemon manager stopped")


async def main():
    """Main entry point."""
    manager = DaemonManager()
    
    def signal_handler(sig_num):
        if sig_num == signal.SIGHUP:
            logger.info("\n🔄 Received SIGHUP signal - reloading config...")
            manager.reload_requested = True
        else:
            logger.info("\n🛑 Received shutdown signal")
            asyncio.create_task(manager.stop_all())
    
    # Register signal handlers
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        loop.add_signal_handler(sig, lambda s=sig: signal_handler(s))
    
    try:
        await manager.start_all()
    except KeyboardInterrupt:
        await manager.stop_all()
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        await manager.stop_all()
        sys.exit(1)


if __name__ == "__main__":
    # FAST-PATH: Check PID file before importing heavy daemon modules.
    # This is an optimization — the flock in start_all() is the real singleton gate.
    # If the PID file points to a live daemon-manager, skip the expensive startup.
    if PID_FILE.exists():
        try:
            existing_pid = int(PID_FILE.read_text().strip())
            try:
                os.kill(existing_pid, 0)  # Check if alive (signal 0 = no-op)
                # Process alive — let flock decide (it's the authority)
                logger.info(f"Existing daemon-manager PID {existing_pid} appears alive, "
                            "attempting flock gate (flock is the authority)")
            except OSError:
                # Process dead — clean stale PID file so we can start fresh
                logger.info(f"Stale PID file (PID {existing_pid} not running), cleaning up")
                PID_FILE.unlink()
        except Exception as e:
            logger.warning(f"Error reading PID file: {e}")
    
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("\nDaemon manager stopped")
