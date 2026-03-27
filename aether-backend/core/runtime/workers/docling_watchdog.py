"""
Docling Health Monitoring Worker

Runtime worker that supervises Docling health (in-process) and optionally logs health to DB.

@.architecture
Incoming: config/settings.py, core/integrations/providers/docling --- {Settings, in-process conversion}
Processing: watchdog_loop() --- {2 jobs: JOB_HEALTH_CHECK, JOB_LOG}
Outgoing: monitoring/logging.py, data/database/repositories/health.py --- {health_status, log_events}
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from contextlib import AsyncExitStack
from typing import Optional

from config.settings import get_settings
from data.database.clients.supabase import SupabaseClient
from data.database.persistence_gateway import SupabasePersistenceGateway
from data.database.repositories.health import HealthRepository

logger = logging.getLogger("jobs.docling_watchdog")


async def initialize_gateway(settings) -> Optional[SupabasePersistenceGateway]:
    if not settings.supabase.enabled:
        return None
    try:
        client = SupabaseClient.from_env(
            {
                "url": settings.supabase.url,
                "anon_key": settings.supabase.anon_key,
                "service_role_key": settings.supabase.service_role_key,
                "schema": settings.supabase.db_schema,
                "realtime_enabled": settings.supabase.realtime_enabled,
            }
        )
        await client.initialize()
        return SupabasePersistenceGateway(client)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Supabase unavailable for integration health tracking: %s", exc)
        return None


async def watchdog_loop(interval: float = 15.0) -> None:
    settings = get_settings()
    if not settings.integrations.docling_enabled:
        logger.info("Docling integration disabled; nothing to monitor.")
        return

    from core.integrations.providers.docling import docling_health

    gateway = await initialize_gateway(settings)
    health_repo = HealthRepository(gateway) if gateway else None

    async with AsyncExitStack():
        try:
            while True:
                try:
                    health = docling_health()
                    is_healthy = bool(health.get("healthy"))
                    status = "healthy" if is_healthy else "unhealthy"
                    if is_healthy:
                        logger.debug("Docling healthy (in-process)")
                    else:
                        logger.warning("Docling unhealthy: %s", health.get("error", "unknown"))
                    if health_repo:
                        await health_repo.record_integration_health("docling", status, health.get("error"))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Docling health check failed: %s", exc)
                    if health_repo:
                        await health_repo.record_integration_health("docling", "unhealthy", str(exc))
                await asyncio.sleep(interval)
        finally:
            if gateway:
                try:
                    await gateway.dispose()
                except Exception:  # noqa: BLE001
                    pass


def configure_logging(verbose: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s :: %(message)s",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Docling watchdog job.")
    parser.add_argument("--interval", type=float, default=15.0, help="Health check interval seconds (default: 15)")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    configure_logging(verbose=args.verbose)
    try:
        asyncio.run(watchdog_loop(interval=args.interval))
    except KeyboardInterrupt:
        logger.info("Docling watchdog interrupted by user.")


if __name__ == "__main__":
    main()

