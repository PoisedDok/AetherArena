"""Real test of email daemon with native Mail.app access."""
import asyncio
import logging
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("RealEmailTest")


async def main():
    from services.daemons.email.daemon import EmailDaemon
    from services.daemons.email.config import EmailDaemonConfig
    from application.sources.macos_mail import test_mail_access
    
    logger.info("=" * 70)
    logger.info("🔥 REAL EMAIL DAEMON TEST")
    logger.info("=" * 70)
    
    # Check Mail.app accessibility
    if sys.platform == "darwin":
        mail_accessible = test_mail_access()
        logger.info(f"\nmacOS Mail.app accessible: {'✓' if mail_accessible else '✗'}")
    
    config = EmailDaemonConfig.from_settings()
    daemon = EmailDaemon(config)
    
    logger.info(f"\n📧 Scanning for emails via AppleScript (max {config.max_emails_per_scan} emails)...")
    await daemon._scan_email_directories()
    
    # Index the logs
    await daemon._index_logs()
    
    # Check results
    stats = daemon.db.get_stats()
    logger.info("\n" + "=" * 70)
    logger.info("📊 RESULTS")
    logger.info("=" * 70)
    logger.info(f"Total logs: {stats['total_logs']}")
    logger.info(f"Unindexed: {stats['unindexed_logs']}")
    
    # Show sample emails
    with daemon.db._get_connection() as conn:
        conn.row_factory = lambda c, r: dict(zip([col[0] for col in c.description], r))
        cursor = conn.execute("SELECT * FROM email_logs ORDER BY timestamp DESC LIMIT 5")
        logs = cursor.fetchall()
        
        if logs:
            logger.info("\nCaptured emails:")
            for log in logs:
                subject = log['subject'][:60] if log['subject'] else "(no subject)"
                logger.info(f"  [{log['sender'][:30]}] {subject}")
        else:
            logger.warning("⚠️  No emails captured!")
            logger.info("\nPossible reasons:")
            logger.info("  - macOS: Grant 'Full Disk Access' to Terminal/Python in System Settings")
            logger.info("  - No emails in configured watch directories")
    
    logger.info("\n✅ Test complete")


if __name__ == "__main__":
    asyncio.run(main())
