"""Quick live test of browser daemon."""
import asyncio
import logging
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

async def main():
    from services.daemons.browser.daemon import BrowserDaemon
    from services.daemons.browser.config import BrowserDaemonConfig
    
    config = BrowserDaemonConfig.from_settings()
    daemon = BrowserDaemon(config)
    
    # Run one scan cycle
    await daemon._scan_browser_history()
    await daemon._index_logs()
    
    stats = daemon.db.get_stats()
    print("\n✅ Browser Daemon Test:")
    print(f"   Total logs: {stats['total_logs']}")
    print(f"   Unindexed: {stats['unindexed_logs']}")
    
    # Show sample logs
    logs = daemon.db.get_unindexed_logs(limit=5)
    if logs:
        print("\n   Sample logs:")
        for log in logs[:3]:
            print(f"   - [{log['timestamp']}] {log['url'][:60]}")

if __name__ == "__main__":
    asyncio.run(main())
