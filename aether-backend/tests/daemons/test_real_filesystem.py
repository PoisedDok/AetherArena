"""Real end-to-end test of filesystem daemon with actual file changes."""
import asyncio
import logging
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("RealFilesystemTest")


async def main():
    from services.daemons.filesystem.daemon import FileSystemDaemon
    from services.daemons.filesystem.config import FileSystemDaemonConfig
    
    config = FileSystemDaemonConfig.from_settings()
    daemon = FileSystemDaemon(config)
    
    logger.info("=" * 70)
    logger.info("🔥 REAL FILESYSTEM DAEMON TEST")
    logger.info("=" * 70)
    logger.info(f"Watching: {config.watch_locations}")
    
    # Start daemon in background
    daemon_task = asyncio.create_task(daemon.start())
    
    # Wait for daemon to initialize
    await asyncio.sleep(3)
    
    # Make real file changes in sample/
    sample_dir = Path("../sample")
    test_file = sample_dir / "daemon_test_file.txt"
    
    logger.info("\n📝 Creating test file...")
    test_file.write_text("Initial content\n")
    await asyncio.sleep(2)
    
    logger.info("✏️  Modifying test file...")
    test_file.write_text("Modified content\n")
    await asyncio.sleep(2)
    
    logger.info("🔄 Renaming test file...")
    renamed_file = sample_dir / "daemon_test_renamed.txt"
    test_file.rename(renamed_file)
    await asyncio.sleep(2)
    
    logger.info("🗑️  Deleting test file...")
    renamed_file.unlink()
    await asyncio.sleep(2)
    
    # Stop daemon
    logger.info("\n🛑 Stopping daemon...")
    await daemon.stop()
    daemon_task.cancel()
    
    # Check results
    logger.info("\n" + "=" * 70)
    logger.info("📊 RESULTS")
    logger.info("=" * 70)
    
    stats = daemon.db.get_stats()
    logger.info(f"Total logs: {stats['total_logs']}")
    logger.info(f"Unindexed: {stats['unindexed_logs']}")
    
    # Show all logs
    with daemon.db._get_connection() as conn:
        conn.row_factory = lambda c, r: dict(zip([col[0] for col in c.description], r))
        cursor = conn.execute("SELECT * FROM fs_logs ORDER BY timestamp DESC LIMIT 20")
        logs = cursor.fetchall()
        
        if logs:
            logger.info("\nCaptured events:")
            for log in logs:
                logger.info(f"  [{log['action']:8s}] {log['file_name']} @ {log['timestamp']}")
        else:
            logger.warning("⚠️  No events captured!")
    
    logger.info("\n✅ Test complete")


if __name__ == "__main__":
    asyncio.run(main())
