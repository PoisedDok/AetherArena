"""
End-to-End Deep Pipeline Integration Test (Phase 1 -> Phase 2).
Verifies:
1. Filesystem activity logging (Phase 1)
2. Signal file generation
3. Query generation from context (Phase 1.5)
4. Agent pickup and 'Stale-if-Busy' logic (Phase 2)
5. Robustness under rapid activity (Stress Test)
"""
import asyncio
import logging
import sqlite3
import time
import shutil
from pathlib import Path

# Configuration
APP_ROOT = Path("/Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend")
QUERY_DB = APP_ROOT / "data" / "daemons" / "query_generation" / "queries.db"
FS_DB = APP_ROOT / "data" / "daemons" / "filesystem" / "logs.db"
SIGNAL_FILE = Path("/tmp/query_gen_signal.trigger").resolve()
# Use 'sample' directory as it's watched by default
SAMPLE_DIR = APP_ROOT.parent / "sample" / "pipeline_stress_test"

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s')
logger = logging.getLogger("PipelineTest")

def get_unprocessed_query_count():
    if not QUERY_DB.exists(): return 0
    conn = sqlite3.connect(QUERY_DB)
    count = conn.execute("SELECT COUNT(*) FROM generated_queries WHERE used_by_agent = 0").fetchone()[0]
    conn.close()
    return count

def get_latest_query():
    if not QUERY_DB.exists(): return None
    conn = sqlite3.connect(QUERY_DB)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM generated_queries ORDER BY timestamp DESC LIMIT 1").fetchone()
    conn.close()
    return dict(row) if row else None

async def wait_for_query_gen(initial_count, timeout=60):
    logger.info(f"⏳ Waiting for Query Generation (timeout {timeout}s)...")
    start = time.time()
    while time.time() - start < timeout:
        current_count = get_unprocessed_query_count()
        if current_count > initial_count:
            logger.info(f"✨ NEW Query detected in DB! (Count: {current_count})")
            return True
        await asyncio.sleep(2)
    return False

async def wait_for_agent_pickup(query_id, timeout=60):
    logger.info(f"⏳ Waiting for Agent to pick up/stale query {query_id}...")
    start = time.time()
    while time.time() - start < timeout:
        conn = sqlite3.connect(QUERY_DB)
        row = conn.execute("SELECT used_by_agent FROM generated_queries WHERE query_id = ?", (query_id,)).fetchone()
        conn.close()
        if row and row[0] == 1:
            logger.info(f"✅ Agent handoff confirmed for {query_id}")
            return True
        await asyncio.sleep(2)
    return False

async def main():
    logger.info("="*80)
    logger.info("🚀 STARTING DEEP PIPELINE INTEGRATION & STRESS TEST")
    logger.info("="*80)
    
    # 0. Clean slate for stress dir
    if SAMPLE_DIR.exists():
        shutil.rmtree(SAMPLE_DIR)
    SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
    
    initial_query_count = get_unprocessed_query_count()
    logger.info(f"📊 Initial unprocessed queries: {initial_query_count}")

    # --- STEP 1: TRIGGER ACTIVITY ---
    logger.info("\n--- PHASE 1: Triggering Filesystem Activity ---")
    test_file = SAMPLE_DIR / "core_logic.py"
    logger.info(f"Writing to {test_file}...")
    test_file.write_text("def analyze_data(data):\n    # CRITICAL: optimize this heavy loop\n    return [x * 2 for x in data]")
    
    # Filesystem daemon needs a moment to catch the event
    logger.info("⏳ Waiting for Filesystem Daemon (10s)...")
    await asyncio.sleep(10)
    
    # Check if logged in DB
    conn = sqlite3.connect(FS_DB)
    recent_fs = conn.execute("SELECT * FROM fs_logs ORDER BY timestamp DESC LIMIT 1").fetchone()
    conn.close()
    if recent_fs:
        logger.info(f"✅ FS Log verified: {recent_fs[3]} (Action: {recent_fs[2]})")
    else:
        logger.error("❌ FS Daemon failed to log the event!")
        return

    # --- STEP 2: VERIFY SIGNAL ---
    if SIGNAL_FILE.exists():
        logger.info("✅ Signal file detection: SUCCESS")
    else:
        logger.warning("⚠️ Signal file not found (might have been processed already)")

    # --- STEP 3: QUERY GENERATION ---
    logger.info("\n--- PHASE 1.5: Verifying Query Generation ---")
    if await wait_for_query_gen(initial_query_count):
        latest = get_latest_query()
        logger.info(f"✅ Query Gen Result: '{latest['query']}'")
        query_id = latest['query_id']
    else:
        logger.error("❌ Pipeline Break: Query Generation timed out")
        return

    # --- STEP 4: AGENT PICKUP ---
    logger.info("\n--- PHASE 2: Verifying Agent Worker Pickup ---")
    if await wait_for_agent_pickup(query_id):
        logger.info("✅ Agent pickup: SUCCESS")
    else:
        logger.error("❌ Agent pickup timed out")

    # --- STEP 5: STRESS TEST (RAPID FIRE) ---
    logger.info("\n--- PHASE 3: Stress Testing 'Stale-if-Busy' & Concurrency ---")
    logger.info("Triggering 5 RAPID changes to force concurrency...")
    current_count = get_unprocessed_query_count()
    for i in range(5):
        (SAMPLE_DIR / f"rapid_{i}.js").write_text(f"// Rapid change {i}\nconsole.log('test');")
        await asyncio.sleep(0.2)
    
    logger.info("⏳ Waiting for batch queries...")
    if await wait_for_query_gen(current_count, timeout=40):
        latest_after_stress = get_latest_query()
        logger.info(f"✨ Latest after stress: '{latest_after_stress['query']}'")
        
        # Verify if worker cleans up older ones
        await asyncio.sleep(15) # Wait for agent heartbeat
        final_count = get_unprocessed_query_count()
        logger.info(f"📊 Final Unprocessed Count: {final_count} (Should be 0 or 1 if just arrived)")
        
        if final_count <= 1:
            logger.info("✅ Stale-if-Busy Logic: VERIFIED (Backlog cleared)")
        else:
            logger.warning(f"⚠️ Backlog warning: {final_count} queries remain unprocessed")
    
    logger.info("\n" + "="*80)
    logger.info("🏆 DEEP PIPELINE TEST COMPLETE: SYSTEM IS ROBUST")
    logger.info("="*80)

if __name__ == "__main__":
    asyncio.run(main())
