"""
Simultaneous Multi-Source Stress Test.
Tests cross-source pattern detection and batching logic.
"""
import asyncio
import logging
import sys
from pathlib import Path
from datetime import datetime, timezone

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from services.daemons.browser.db import BrowserDB
from services.daemons.email.db import EmailDB
from services.daemons.filesystem.db import FileSystemDB
from services.daemons.query_generation.daemon import QueryGenerationDaemon
from services.daemons.query_generation.config import QueryGenerationDaemonConfig

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("MultiSourceStress")

async def main():
    logger.info("🔥 Starting Multi-Source Stress Test")
    
    # 1. Setup DBs
    from services.daemons.browser.config import BrowserDaemonConfig
    from services.daemons.email.config import EmailDaemonConfig
    from services.daemons.filesystem.config import FileSystemDaemonConfig
    
    browser_db = BrowserDB(BrowserDaemonConfig.from_settings().db_path)
    email_db = EmailDB(EmailDaemonConfig.from_settings().db_path)
    fs_db = FileSystemDB(FileSystemDaemonConfig.from_settings().db_path)
    
    # 2. Insert Simultaneous Activity (Simulating a user debugging a problem)
    ts = datetime.now(timezone.utc).isoformat()
    
    logger.info("📥 Injecting cross-source activity...")
    
    # Browser: Searching for OAuth error
    browser_db.insert_log(url="https://stackoverflow.com/questions/123/oauth-token-expired", title="OAuth token expired error", timestamp=ts)
    browser_db.insert_log(url="https://google.com/search?q=python+httpx+auth+refresh", title="google search", timestamp=ts)
    
    # Email: Received a notification about a system alert
    email_db.insert_log(subject="CRITICAL: OAuth Service Down", sender="alerts@system.com", recipients="me@me.com", body_preview="Token validation is failing for all users in production.", timestamp=ts)
    
    # Filesystem: User modifying auth_service.py
    fs_db.insert_log(action="modified", file_path="/src/auth_service.py", location_name="src", content_preview="def validate_token(): # BUG: checking wrong field", timestamp=ts)
    
    logger.info("⚙️ Running Cross-Source Query Generation...")
    
    qgen_config = QueryGenerationDaemonConfig.from_settings()
    daemon = QueryGenerationDaemon(qgen_config)
    
    # Force process
    processed_count = await daemon._process_new_logs()
    
    logger.info(f"✅ Generated {processed_count} cross-source queries")
    
    # Show the generated queries
    recent_queries = daemon.db.get_recent_queries(limit=3)
    for q in recent_queries:
        logger.info(f"✨ SIGNAL: {q['query']}")
        logger.info(f"   Context Sources: {[d.get('url') or d.get('subject') or d.get('file_path') for d in q['context_docs']][:5]}")

if __name__ == "__main__":
    asyncio.run(main())
