"""
Robust End-to-End Test for Phase 1 Proactive Daemons.
Tests: Fake data insertion, Deduplication, Signal Generation, Query Generation.
"""
import asyncio
import logging
import sys
import shutil
from pathlib import Path
from datetime import datetime, timezone

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from services.daemons.browser.db import BrowserDB
from services.daemons.email.db import EmailDB
from services.daemons.query_generation.daemon import QueryGenerationDaemon
from services.daemons.query_generation.config import QueryGenerationDaemonConfig
from services.daemons.browser.config import BrowserDaemonConfig
from services.daemons.email.config import EmailDaemonConfig
from services.daemons.filesystem.config import FileSystemDaemonConfig

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("RobustDaemonTest")

# Constants
SIGNAL_FILE = Path("/tmp/query_gen_signal.trigger").resolve()
SAMPLE_DIR = Path("/Volumes/Disk-D/Aether/Aether/AetherArena/sample/test_robust")

async def setup_environment():
    """Ensure clean slate for testing."""
    if SAMPLE_DIR.exists():
        shutil.rmtree(SAMPLE_DIR)
    SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
    
    if SIGNAL_FILE.exists():
        SIGNAL_FILE.unlink()
    
    logger.info("✅ Environment setup complete")

async def test_deduplication_and_insertion():
    """Test fake data insertion and deduplication logic."""
    logger.info("\n--- Phase 1.1: Data Insertion & Deduplication ---")
    
    # 1. Browser
    browser_config = BrowserDaemonConfig.from_settings()
    browser_db = BrowserDB(browser_config.db_path)
    
    ts = datetime.now(timezone.utc).isoformat()
    url = "https://example.com/test-robust"
    
    logger.info("Inserting browser log...")
    id1 = browser_db.insert_log(url=url, title="Robust Test", timestamp=ts)
    logger.info(f"   Browser ID 1: {id1}")
    
    logger.info("Inserting DUPLICATE browser log...")
    id2 = browser_db.insert_log(url=url, title="Robust Test Duplicate", timestamp=ts)
    logger.info(f"   Browser ID 2: {id2}")
    
    assert id1 == id2, "Browser deduplication failed!"
    logger.info("   ✅ Browser deduplication verified")

    # 2. Email
    email_config = EmailDaemonConfig.from_settings()
    email_db = EmailDB(email_config.db_path)
    
    sender = "tester@robust.ai"
    subject = "Robust Stress Test"
    
    logger.info("Inserting email log...")
    eid1 = email_db.insert_log(sender=sender, subject=subject, recipients="user@me.com", body_preview="Test content", timestamp=ts)
    logger.info(f"   Email ID 1: {eid1}")
    
    logger.info("Inserting DUPLICATE email log...")
    eid2 = email_db.insert_log(sender=sender, subject=subject, recipients="user@me.com", body_preview="Test content duplicate", timestamp=ts)
    logger.info(f"   Email ID 2: {eid2}")
    
    assert eid2 is None, f"Email deduplication failed! Expected None for duplicate, got {eid2}"
    logger.info("   ✅ Email deduplication verified")

async def test_signal_generation():
    """Test that filesystem changes trigger signals."""
    logger.info("\n--- Phase 1.2: Filesystem Signal Generation ---")
    
    from services.daemons.filesystem.daemon import FileSystemDaemon
    fs_config = FileSystemDaemonConfig.from_settings()
    # Update watch location to our test dir
    fs_config.watch_locations = [str(SAMPLE_DIR)]
    
    fs_daemon = FileSystemDaemon(fs_config)
    
    # Manually trigger the logic that the watcher would trigger
    logger.info(f"Simulating file creation in {SAMPLE_DIR}")
    test_file = SAMPLE_DIR / "activity.txt"
    test_file.write_text("User is working on robust testing.")
    
    # In a real run, the watchdog would call this:
    fs_daemon.db.insert_log(
        action="created",
        file_path=str(test_file),
        location_name="test_robust"
    )
    fs_daemon._check_threshold_and_signal()
    
    assert SIGNAL_FILE.exists(), "Signal file was not created!"
    logger.info("   ✅ Signal file generation verified")

async def test_query_generation_logic():
    """Test that QueryGenerationDaemon processes these logs."""
    logger.info("\n--- Phase 1.3: Query Generation Processing ---")
    
    qgen_config = QueryGenerationDaemonConfig.from_settings()
    daemon = QueryGenerationDaemon(qgen_config)
    
    # Clear stale logs from previous runs if any (our new fix)
    await daemon._mark_existing_logs_stale()
    
    # Now insert NEW logs that should be processed
    browser_config = BrowserDaemonConfig.from_settings()
    browser_db = BrowserDB(browser_config.db_path)
    
    for i in range(5):
        browser_db.insert_log(
            url=f"https://example.com/stress-{i}",
            title=f"Stress Visit {i}",
            timestamp=datetime.now(timezone.utc).isoformat()
        )
    
    logger.info("Running query generation cycle...")
    # This will pick up the 5 new browser logs
    processed_count = await daemon._process_new_logs()
    
    logger.info(f"   Processed {processed_count} queries")
    
    # Verify logs are marked as processed
    unprocessed = browser_db.get_unprocessed_count()
    logger.info(f"   Remaining unprocessed browser logs: {unprocessed}")
    
    assert unprocessed == 0, "Logs were not marked as processed!"
    logger.info("   ✅ Query generation processing and marking verified")

async def test_start_from_now_logic():
    """Verify that daemons ignore historical data."""
    logger.info("\n--- Phase 1.4: Start-from-now Logic Verification ---")
    
    from services.daemons.browser.daemon import BrowserDaemon
    browser_config = BrowserDaemonConfig.from_settings()
    daemon = BrowserDaemon(browser_config)
    
    # Daemon start time is now
    start_time = daemon.daemon_start_time
    logger.info(f"   Daemon start time: {start_time}")
    
    assert daemon._last_seen_visit_time == start_time, "Initial visit time should be start time"
    logger.info("   ✅ Browser daemon since_time initialized to start_time")

async def main():
    try:
        await setup_environment()
        await test_deduplication_and_insertion()
        await test_signal_generation()
        await test_query_generation_logic()
        await test_start_from_now_logic()
        
        logger.info("\n" + "=" * 60)
        logger.info("🏆 ALL ROBUST TESTS PASSED")
        logger.info("=" * 60)
    except Exception as e:
        logger.error(f"❌ Robust test failed: {e}", exc_info=True)
    finally:
        # Cleanup
        if SAMPLE_DIR.exists():
            shutil.rmtree(SAMPLE_DIR)
        if SIGNAL_FILE.exists():
            SIGNAL_FILE.unlink()

if __name__ == "__main__":
    asyncio.run(main())
