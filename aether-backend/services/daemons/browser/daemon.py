"""Browser history logging daemon."""
import asyncio
import logging
import signal
from datetime import datetime, timezone

from services.daemons.browser.config import BrowserDaemonConfig
from services.daemons.browser.db import BrowserDB
from application.sources.chromium_history import (
    resolve_chromium_user_data_dir,
    find_profile_dirs,
    read_history_entries,
    extract_search_query,
)
from services.daemons import QUERY_GEN_SIGNAL_FILE

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("BrowserDaemon")


class BrowserDaemon:
    """Main daemon for browser history logging."""
    
    def __init__(self, config: BrowserDaemonConfig):
        self.config = config
        self.running = False
        self._is_disposed = False
        self.db = BrowserDB(config.db_path)
        
        # Daemon start time - only log NEW visits from this point forward
        self.daemon_start_time = datetime.now(timezone.utc)
        self._last_seen_visit_time = self.daemon_start_time  # Track last processed visit
        
        self.last_scan_time = self.daemon_start_time
        self.last_cleanup_time = self.daemon_start_time
        self.last_config_check = self.daemon_start_time
        self.config_check_interval = 10  # Check config every 10 seconds
        
        # Edge-crossing flag for threshold-based signaling.
        # _check_threshold_and_signal reads unprocessed count from DB.
        self._has_signaled = False
    
    async def start(self):
        """Start the daemon loop."""
        logger.info(f"🚀 Starting Browser Daemon (heartbeat: {self.config.scan_interval_seconds}s)")
        self.running = True
        
        while self.running:
            try:
                now = datetime.now(timezone.utc)
                
                # 0. Check for config updates and reload if changed
                if (now - self.last_config_check).total_seconds() >= self.config_check_interval:
                    await self._check_and_reload_config()
                    self.last_config_check = now
                
                # 1. Check threshold and signal if needed (handles missed rapid changes)
                self._check_threshold_and_signal()
                
                # 2. Scan browser history periodically
                if (now - self.last_scan_time).total_seconds() >= self.config.scan_interval_seconds:
                    await self._scan_browser_history()
                    self.last_scan_time = now
                
                # 3. Cleanup old logs daily
                if (now - self.last_cleanup_time).total_seconds() >= 86400:  # 24 hours
                    await self._cleanup_old_logs()
                    self.last_cleanup_time = now
                
                await asyncio.sleep(5)  # Check every 5 seconds
                
            except Exception as e:
                logger.error(f"Error in main loop: {e}", exc_info=True)
                await asyncio.sleep(5)
    
    async def stop(self):
        """Graceful shutdown -- set disposed."""
        if self._is_disposed:
            return
        self._is_disposed = True
        
        logger.info("Stopping Browser Daemon...")
        self.running = False
    
    async def _check_and_reload_config(self):
        """Check if config has changed and reload if necessary."""
        try:
            new_config = BrowserDaemonConfig.from_settings()
            
            # Compare key config values
            if (new_config.scan_interval_seconds != self.config.scan_interval_seconds or
                new_config.bm25_index_interval_seconds != self.config.bm25_index_interval_seconds or
                new_config.excluded_profiles != self.config.excluded_profiles):
                
                logger.info("🔄 Config changed, reloading...")
                logger.info(f"   Old: scan={self.config.scan_interval_seconds}s, excluded={self.config.excluded_profiles}")
                logger.info(f"   New: scan={new_config.scan_interval_seconds}s, excluded={new_config.excluded_profiles}")
                
                self.config = new_config
                    
        except Exception as e:
            logger.error(f"Failed to reload config: {e}", exc_info=True)
    
    async def _scan_browser_history(self):
        """
        Scan browser history and insert directly to DB.

        D5 fix: eliminated in-memory queue. Each entry goes to SQLite
        immediately so no data is lost on crash. Threshold signal fires
        immediately after inserts (matching email/filesystem daemon pattern).
        """
        try:
            user_data_dir = resolve_chromium_user_data_dir(self.config.browser)
            if not user_data_dir:
                logger.warning(f"Could not resolve user data dir for {self.config.browser}")
                return
            
            profile_paths = find_profile_dirs(user_data_dir)
            if not profile_paths:
                logger.warning(f"No profiles found in {user_data_dir}")
                return
            
            new_entries = []
            for profile_path in profile_paths:
                if profile_path.name in self.config.excluded_profiles:
                    logger.info(f"Skipping excluded profile: {profile_path.name}")
                    continue
                
                try:
                    entries = read_history_entries(
                        profile_dir=profile_path,
                        max_items=100,
                        since_time=self._last_seen_visit_time
                    )
                    
                    for entry in entries:
                        visit_time = entry.get('last_visit_time')
                        # Primary: extract search query from URL parameters (deterministic)
                        search_q = extract_search_query(entry['url'])
                        new_entries.append({
                            'url': entry['url'],
                            'title': entry.get('title'),
                            'visit_count': entry.get('visit_count', 1),
                            'typed_count': entry.get('typed_count', 0),
                            'profile': profile_path.name,
                            'timestamp': visit_time if visit_time else datetime.now(timezone.utc).isoformat(),
                            'search_query': search_q,
                        })
                    
                except Exception as e:
                    logger.error(f"Failed to read history from {profile_path.name}: {e}")
            
            if new_entries:
                # Insert directly to DB (crash-safe — no in-memory buffer)
                for entry in new_entries:
                    self.db.insert_log(
                        url=entry['url'],
                        title=entry['title'],
                        visit_count=entry['visit_count'],
                        typed_count=entry['typed_count'],
                        profile=entry['profile'],
                        timestamp=entry['timestamp'],
                        search_query=entry.get('search_query'),
                    )
                
                # Update last seen visit time to prevent re-processing
                latest_timestamp = max(e['timestamp'] for e in new_entries)
                self._last_seen_visit_time = datetime.fromisoformat(
                    latest_timestamp.replace('Z', '+00:00')
                )
                
                logger.debug(f"Inserted {len(new_entries)} browser logs to DB")
                # Signal query gen if threshold crossed (immediate, not deferred to next loop)
                self._check_threshold_and_signal()
            else:
                logger.debug("No new browser visits since last scan")
            
        except Exception as e:
            logger.error(f"Failed to scan browser history: {e}", exc_info=True)
    
    def _check_threshold_and_signal(self):
        """
        Signal query gen ONLY when crossing threshold (prevents signal storm).
        Signals once when unprocessed goes from <2 to >=2.
        Resets flag when count drops back below threshold.
        """
        try:
            unprocessed_count = self.db.get_unprocessed_count()
            threshold = 2  # Browser threshold: matches coherent-engagement minimum (2+ related visits)
            
            if unprocessed_count >= threshold and not self._has_signaled:
                # CROSSING threshold - signal once
                QUERY_GEN_SIGNAL_FILE.touch()
                self._has_signaled = True
                logger.info(f"🔔 Threshold CROSSED: {unprocessed_count} unprocessed logs (>= {threshold}) → Signaled query gen")
            elif unprocessed_count < threshold and self._has_signaled:
                # Dropped below threshold - reset flag for next batch
                self._has_signaled = False
                logger.debug(f"Reset signal flag: {unprocessed_count} < {threshold}")
        except Exception as e:
            logger.error(f"Failed to check threshold: {e}", exc_info=True)
    
    async def _cleanup_old_logs(self):
        """Cleanup logs older than retention days."""
        try:
            self.db.cleanup_old_logs(self.config.retention_days)
        except Exception as e:
            logger.error(f"Failed to cleanup old logs: {e}", exc_info=True)


async def main():
    """Entry point for browser daemon."""
    config = BrowserDaemonConfig.from_settings()
    daemon = BrowserDaemon(config)
    
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(daemon.stop()))
    
    try:
        await daemon.start()
    except Exception as e:
        logger.error(f"Daemon failed: {e}", exc_info=True)
    finally:
        # Safe to call even if already stopped -- disposed guard prevents double-stop
        await daemon.stop()


if __name__ == "__main__":
    asyncio.run(main())
