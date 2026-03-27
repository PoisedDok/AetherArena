import asyncio
import logging
import sys
from pathlib import Path

# Add backend root to sys.path
backend_root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(backend_root))

from config.settings import get_settings
from workers.handlers.proactive_agent_handler import ProactiveAgentWorker

async def main():
    # Configure logging to stdout
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-8s | %(name)-30s | %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)]
    )
    
    logger = logging.getLogger("standalone_worker")
    logger.info("Starting standalone ProactiveAgentWorker for simulation...")
    
    settings = get_settings()
    
    anon = settings.supabase.anon_key
    service = settings.supabase.service_role_key
    logger.info(f"ANON_KEY loaded: {anon[:10] if anon else 'None'}...")
    logger.info(f"SERVICE_ROLE_KEY loaded: {service[:10] if service else 'None'}...")

    # Force enable the worker in settings for the simulation
    settings.proactive.agent_worker.enabled = True
    
    # INITIALIZE DATABASE CONNECTION
    from data.database.clients.supabase import SupabaseClient
    from data.database.persistence_gateway import SupabasePersistenceGateway
    from api.dependencies import set_database_connection
    
    # Log Supabase config (without keys)
    logger.info(f"Supabase URL: {settings.supabase.url}")
    
    supabase_client = SupabaseClient.from_env({
        "url": settings.supabase.url,
        "anon_key": settings.supabase.anon_key,
        "service_role_key": settings.supabase.service_role_key,
        "schema": settings.supabase.db_schema,
        "realtime_enabled": settings.supabase.realtime_enabled
    })
    await supabase_client.initialize()
    gateway = SupabasePersistenceGateway(supabase_client)
    set_database_connection(gateway)
    logger.info("✅ Supabase gateway initialized")
    
    worker = ProactiveAgentWorker(
        app_root=settings.app_root,
        settings=settings
    )
    
    try:
        await worker.start()
    except KeyboardInterrupt:
        logger.info("Worker stopped by user")
    except Exception as e:
        logger.error(f"Worker failed: {e}", exc_info=True)
    finally:
        worker.stop()

if __name__ == "__main__":
    asyncio.run(main())
