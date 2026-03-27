"""Email logging daemon."""
import asyncio
import logging
import signal
from datetime import datetime, timezone
from typing import Optional

from services.daemons.email.config import EmailDaemonConfig
from services.daemons.email.db import EmailDB
from application.sources.macos_mail import (
    get_recent_emails_via_applescript,
    test_mail_access
)
from services.daemons import QUERY_GEN_SIGNAL_FILE
import sys

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("EmailDaemon")


class EmailDaemon:
    """Main daemon for email logging."""
    
    def __init__(self, config: EmailDaemonConfig):
        self.config = config
        self.running = False
        self._is_disposed = False
        self.db = EmailDB(config.db_path)
        
        # Daemon start time - only log NEW emails from this point forward (like browser daemon)
        self.daemon_start_time = datetime.now(timezone.utc)
        
        self.last_scan_time = self.daemon_start_time
        self.last_cleanup_time = self.daemon_start_time
        self.last_config_check = self.daemon_start_time
        self.config_check_interval = 10  # Check config every 10 seconds
        
        self._last_seen_email_date = None  # Track most recent email timestamp (incremental scanning)
        self._has_signaled = False  # Track if we've signaled (prevents signal storm)
        self._mail_accessible = False  # Cached result of test_mail_access() (set once in start())
    
    async def start(self):
        """Start the daemon loop."""
        logger.info(f"🚀 Starting Email Daemon (heartbeat: {self.config.scan_interval_seconds}s)")
        
        # Test Mail.app accessibility ONCE at startup and cache the result.
        # macOS Automation permission doesn't change at runtime, so re-testing
        # every scan cycle wastes an osascript subprocess and logs noise when
        # permission is denied.
        if sys.platform == "darwin":
            self._mail_accessible = test_mail_access()
            if self._mail_accessible:
                logger.info("✅ Mail.app is accessible via AppleScript")
            else:
                logger.warning("Mail.app not accessible (Automation permission not granted)")
        
        
        self.running = True
        
        logger.info(f"📊 Email daemon loop starting (scan_interval={self.config.scan_interval_seconds}s)")
        
        while self.running:
            try:
                now = datetime.now(timezone.utc)
                
                # 0. Check for config updates and reload if changed
                if (now - self.last_config_check).total_seconds() >= self.config_check_interval:
                    await self._check_and_reload_config()
                    self.last_config_check = now
                
                # 1. Check threshold and signal if needed (handles missed rapid changes)
                self._check_threshold_and_signal()
                
                # 2. Scan email directories periodically
                elapsed = (now - self.last_scan_time).total_seconds()
                if elapsed >= self.config.scan_interval_seconds:
                    logger.debug(f"Email scan triggered (elapsed: {elapsed:.1f}s >= {self.config.scan_interval_seconds}s)")
                    await self._scan_email_directories()
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
        
        logger.info("Stopping Email Daemon...")
        self.running = False
    
    async def _check_and_reload_config(self):
        """Check if config has changed and reload if necessary."""
        try:
            new_config = EmailDaemonConfig.from_settings()
            
            # Compare key config values
            if (new_config.scan_interval_seconds != self.config.scan_interval_seconds or
                new_config.bm25_index_interval_seconds != self.config.bm25_index_interval_seconds or
                new_config.max_emails_per_scan != self.config.max_emails_per_scan):
                
                logger.info("Config changed, reloading...")
                logger.info(f"   Old: scan={self.config.scan_interval_seconds}s, max_per_scan={self.config.max_emails_per_scan}")
                logger.info(f"   New: scan={new_config.scan_interval_seconds}s, max_per_scan={new_config.max_emails_per_scan}")
                
                self.config = new_config
                    
        except Exception as e:
            logger.error(f"Failed to reload config: {e}", exc_info=True)
    
    def _parse_applescript_date(self, date_str: str) -> Optional[datetime]:
        """
        Parse macOS AppleScript date formats to datetime object.
        
        Supports multiple AppleScript formats:
        - "Tuesday, January 30, 2026 at 10:15:32 PM" (US locale, 12h)
        - "Tuesday, 8 October 2024 at 23:38:44" (UK/other locale, 24h, day-first)
        - "Tuesday, 30 May 2023 at 07:17:59" (day-first, 24h)
        """
        if not date_str:
            return None
        
        # Try dateparser first (handles most formats robustly)
        try:
            import dateparser
            dt = dateparser.parse(date_str, settings={'PREFER_DATES_FROM': 'past'})
            if dt:
                if dt.tzinfo is None:
                    # AppleScript returns local time; we must convert it to UTC, not just replace the tzinfo
                    dt = dt.astimezone(timezone.utc)
                return dt
        except ImportError:
            pass
        except Exception as e:
            logger.debug(f"dateparser failed for '{date_str}': {e}")
        
        # Manual fallback for AppleScript formats (try all known patterns)
        # Remove day-of-week prefix if present: "Tuesday, " → ""
        clean_str = date_str
        if ',' in date_str:
            parts = date_str.split(',', 1)
            if len(parts) > 1:
                clean_str = parts[1].strip()  # "8 October 2024 at 23:38:44"
        
        # Remove " at " separator
        clean_str = clean_str.replace(' at ', ' ')  # "8 October 2024 23:38:44"
        
        # Try multiple strptime formats
        formats = [
            "%d %B %Y %H:%M:%S",      # "8 October 2024 23:38:44" (day-first, 24h)
            "%B %d %Y %H:%M:%S",      # "October 8 2024 23:38:44" (month-first, 24h)
            "%d %B %Y %I:%M:%S %p",   # "8 October 2024 11:38:44 PM" (day-first, 12h)
            "%B %d %Y %I:%M:%S %p",   # "October 8 2024 11:38:44 PM" (month-first, 12h)
        ]
        
        for fmt in formats:
            try:
                dt = datetime.strptime(clean_str, fmt)
                return dt.astimezone(timezone.utc)
            except ValueError:
                continue
        
        logger.debug(f"All date parse attempts failed for '{date_str}'")
        return None

    async def _scan_email_directories(self):
        """
        Scan for emails using AppleScript (macOS) or file-based access.
        
        macOS: AppleScript via osascript (NO Full Disk Access required)
        Windows: .eml/.mbox files from configured directories
        """
        try:
            total_inserted = 0
            
            # macOS Mail.app via AppleScript (NO permissions required)
            if sys.platform == "darwin":
                try:
                    if self._mail_accessible:
                        # Fetch emails (AppleScript fetches most recent 50)
                        emails = get_recent_emails_via_applescript(max_items=self.config.max_emails_per_scan)
                        
                        logger.info(f"📬 AppleScript returned {len(emails)} total emails from Mail.app")
                        
                        if not emails:
                            logger.info("⚠️ No emails returned from Mail.app (mailbox might be empty or AppleScript failed)")
                            return
                        
                        # Filter: Only process emails received AFTER daemon_start_time (like browser daemon)
                        # This ensures we only log NEW emails from the point daemon started
                        new_emails = []
                        filtered_old = 0
                        filtered_seen = 0
                        parse_failed = 0
                        
                        for email_data in emails:
                            email_date_str = email_data.get('dateReceived', '')
                            email_dt = self._parse_applescript_date(email_date_str)
                            
                            if not email_dt:
                                parse_failed += 1
                                logger.warning(f"❌ Could not parse date: '{email_date_str}', skipping")
                                continue

                            # 1. Filter by daemon start time (never log old history)
                            if email_dt < self.daemon_start_time:
                                filtered_old += 1
                                continue

                            # 2. Incremental filter (skip already seen in this session)
                            if self._last_seen_email_date and email_dt <= self._last_seen_email_date:
                                filtered_seen += 1
                                continue
                            
                            email_data['_parsed_dt'] = email_dt
                            new_emails.append(email_data)
                        
                        logger.info(f"📊 Filter results: {len(new_emails)} NEW, {filtered_old} too old, {filtered_seen} already seen, {parse_failed} parse failed")
                        
                        if not new_emails:
                            logger.debug("No new emails (all already scanned or too old)")
                            return
                        
                        # Log only when we have NEW emails to process
                        logger.info(f"📧 Found {len(new_emails)} new emails in Mail.app since {self.daemon_start_time}")
                        
                        # Sort by date so we process in order and update _last_seen_email_date correctly
                        new_emails.sort(key=lambda x: x['_parsed_dt'])

                        for email_data in new_emails:
                            email_dt = email_data['_parsed_dt']
                            
                            inserted_id = self.db.insert_log(
                                subject=email_data.get('subject', ''),
                                sender=email_data.get('sender', ''),
                                recipients='',  # Recipients not needed for proactive context
                                body_preview=email_data.get('content', ''),
                                file_path="Mail.app",
                                timestamp=email_dt.isoformat() # PASS ACTUAL TIMESTAMP FOR DEDUPLICATION
                            )
                            
                            if inserted_id:
                                total_inserted += 1
                            
                            # Track most recent email date for incremental scanning
                            if not self._last_seen_email_date or email_dt > self._last_seen_email_date:
                                self._last_seen_email_date = email_dt
                        
                        if total_inserted > 0:
                            logger.info(f"✅ Inserted {total_inserted} NEW emails to DB")
                            # Check if we hit threshold for query generation
                            self._check_threshold_and_signal()
                    else:
                        logger.debug("Mail.app not running or accessible")
                except Exception as e:
                    logger.error(f"Failed to access Mail.app via AppleScript: {e}")
            
            # Windows Outlook via COM API (future)
            elif sys.platform == "win32":
                logger.info("Windows Outlook COM API: not yet implemented (see FUTURE_WORK Section 7.2)")
            
        except Exception as e:
            logger.error(f"Failed to scan email directories: {e}", exc_info=True)
    
    def _check_threshold_and_signal(self):
        """
        Signal query gen ONLY when crossing threshold (prevents signal storm).
        Signals once when unprocessed goes from <1 to >=1.
        Resets flag when count drops back below threshold.
        """
        try:
            unprocessed_count = self.db.get_unprocessed_count()
            threshold = 1  # Email threshold (every email matters)
            
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
    """Entry point for email daemon."""
    config = EmailDaemonConfig.from_settings()
    daemon = EmailDaemon(config)
    
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
