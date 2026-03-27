"""Live test of filesystem daemon."""
import asyncio
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

async def main():
    from services.daemons.filesystem.daemon import FileSystemDaemon
    from services.daemons.filesystem.config import FileSystemDaemonConfig
    
    config = FileSystemDaemonConfig.from_settings()
    daemon = FileSystemDaemon(config)
    
    print("\n🔍 Filesystem Daemon Test")
    print(f"   Watching: {config.watch_locations}")
    print("\n   Creating test file in ../sample/test.txt...")
    
    # Create test file
    test_file = Path("../sample/test_daemon_file.txt")
    test_file.write_text("Test content from daemon\n")
    
    # Start daemon briefly to capture events
    print("   Starting daemon for 10 seconds...")
    asyncio.create_task(daemon.start())
    
    await asyncio.sleep(10)
    await daemon.stop()
    
    # Check stats
    stats = daemon.db.get_stats()
    print("\n✅ Filesystem Daemon Stats:")
    print(f"   Total logs: {stats['total_logs']}")
    print(f"   Unindexed: {stats['unindexed_logs']}")
    
    # Show logs
    with daemon.db._get_connection() as conn:
        conn.row_factory = lambda c, r: dict(zip([col[0] for col in c.description], r))
        cursor = conn.execute("SELECT * FROM fs_logs ORDER BY timestamp DESC LIMIT 5")
        logs = cursor.fetchall()
        
        if logs:
            print("\n   Recent logs:")
            for log in logs:
                print(f"   - [{log['action']}] {log['file_name']}")
    
    # Cleanup test file
    if test_file.exists():
        test_file.unlink()
        print("\n   Cleaned up test file")

if __name__ == "__main__":
    asyncio.run(main())
