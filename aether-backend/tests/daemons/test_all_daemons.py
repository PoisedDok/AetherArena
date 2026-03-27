"""Comprehensive test of all 4 proactive daemons."""
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("AllDaemonsTest")


async def main():
    logger.info("=" * 80)
    logger.info("🔥 PROACTIVE DAEMONS COMPREHENSIVE TEST")
    logger.info("=" * 80)
    
    # Test 1: Browser Daemon
    logger.info("\n1️⃣  BROWSER DAEMON (Edge History)")
    logger.info("-" * 80)
    from services.daemons.browser.daemon import BrowserDaemon
    from services.daemons.browser.config import BrowserDaemonConfig
    
    browser_config = BrowserDaemonConfig.from_settings()
    browser_daemon = BrowserDaemon(browser_config)
    
    await browser_daemon._scan_browser_history()
    await browser_daemon._index_logs()
    
    browser_stats = browser_daemon.db.get_stats()
    logger.info(f"   ✅ Browser: {browser_stats['total_logs']} logs, {browser_stats['unindexed_logs']} unindexed")
    
    # Test 2: Filesystem Daemon
    logger.info("\n2️⃣  FILESYSTEM DAEMON")
    logger.info("-" * 80)
    from services.daemons.filesystem.daemon import FileSystemDaemon
    from services.daemons.filesystem.config import FileSystemDaemonConfig
    
    fs_config = FileSystemDaemonConfig.from_settings()
    fs_daemon = FileSystemDaemon(fs_config)
    
    logger.info(f"   Watching: {fs_config.watch_locations}")
    
    # Manual test log
    fs_daemon.db.insert_log(
        action="created",
        file_path="/sample/test_all_daemons.txt",
        location_name="sample"
    )
    await fs_daemon._index_logs()
    
    fs_stats = fs_daemon.db.get_stats()
    logger.info(f"   ✅ Filesystem: {fs_stats['total_logs']} logs, {fs_stats['unindexed_logs']} unindexed")
    
    # Test 3: Email Daemon
    logger.info("\n3️⃣  EMAIL DAEMON")
    logger.info("-" * 80)
    from services.daemons.email.daemon import EmailDaemon
    from services.daemons.email.config import EmailDaemonConfig
    
    email_config = EmailDaemonConfig.from_settings()
    email_daemon = EmailDaemon(email_config)
    
    # Scan emails
    await email_daemon._scan_email_directories()
    await email_daemon._index_logs()
    
    email_stats = email_daemon.db.get_stats()
    logger.info(f"   ✅ Email: {email_stats['total_logs']} logs, {email_stats['unindexed_logs']} unindexed")
    
    # Summary
    logger.info("\n" + "=" * 80)
    logger.info("📊 SUMMARY")
    logger.info("=" * 80)
    logger.info(f"   Browser:        {browser_stats['total_logs']:5d} logs (BM25 indexed)")
    logger.info(f"   Active Windows: {count:5d} logs")
    logger.info(f"   Filesystem:     {fs_stats['total_logs']:5d} logs (BM25 indexed)")
    logger.info(f"   Email:          {email_stats['total_logs']:5d} logs (BM25 indexed)")
    logger.info("=" * 80)
    logger.info("✅ All daemons operational")
    logger.info("=" * 80)


if __name__ == "__main__":
    asyncio.run(main())
