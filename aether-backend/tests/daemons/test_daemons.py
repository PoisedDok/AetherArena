"""Test script for all proactive daemons."""
import asyncio
import logging
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("DaemonTest")


async def run_browser_daemon():
    """Test browser daemon."""
    logger.info("=" * 60)
    logger.info("Testing Browser Daemon")
    logger.info("=" * 60)
    
    from services.daemons.browser.config import BrowserDaemonConfig
    from services.daemons.browser.daemon import BrowserDaemon
    
    config = BrowserDaemonConfig.from_settings()
    logger.info(f"Config: scan={config.scan_interval_seconds}s, browser={config.browser}")
    
    daemon = BrowserDaemon(config)
    
    # Test one cycle
    await daemon._scan_browser_history()
    await daemon._index_logs()
    
    # Check stats
    stats = daemon.db.get_stats()
    logger.info(f"✓ Browser DB Stats: {stats}")
    

async def run_email_daemon():
    """Test email daemon."""
    logger.info("=" * 60)
    logger.info("Testing Email Daemon")
    logger.info("=" * 60)
    
    from services.daemons.email.config import EmailDaemonConfig
    from services.daemons.email.daemon import EmailDaemon
    
    config = EmailDaemonConfig.from_settings()
    logger.info(f"Config: scan={config.scan_interval_seconds}s")
    
    daemon = EmailDaemon(config)
    
    # Test one cycle
    await daemon._scan_email_directories()
    await daemon._index_logs()
    
    # Check stats
    stats = daemon.db.get_stats()
    logger.info(f"✓ Email DB Stats: {stats}")


async def run_filesystem_daemon():
    """Test filesystem daemon."""
    logger.info("=" * 60)
    logger.info("Testing Filesystem Daemon")
    logger.info("=" * 60)
    
    from services.daemons.filesystem.config import FileSystemDaemonConfig
    from services.daemons.filesystem.daemon import FileSystemDaemon
    
    config = FileSystemDaemonConfig.from_settings()
    logger.info(f"Config: index={config.bm25_index_interval_seconds}s, watch_locations={config.watch_locations}")
    
    daemon = FileSystemDaemon(config)
    
    # Manually insert a test log
    daemon.db.insert_log(
        action="test_created",
        file_path="/test/file.txt",
        location_name="test"
    )
    
    # Test indexing
    await daemon._index_logs()
    
    # Check stats
    stats = daemon.db.get_stats()
    logger.info(f"✓ Filesystem DB Stats: {stats}")


async def main():
    """Run all daemon tests."""
    try:
        await run_browser_daemon()
        await run_email_daemon()
        await run_filesystem_daemon()
        
        logger.info("=" * 60)
        logger.info("✅ All daemon tests completed")
        logger.info("=" * 60)
    except Exception as e:
        logger.error(f"Test failed: {e}", exc_info=True)


if __name__ == "__main__":
    asyncio.run(main())
