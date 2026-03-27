"""
Health Repository
Repository for tracking integration and system health status.

@.architecture
Incoming: core/runtime/workers/docling_watchdog.py, monitoring/health.py --- {Dict[str, Any], json}
Processing: upsert health records, query status --- {2 jobs: JOB_QUERY_DB, JOB_SAVE_TO_DB}
Outgoing: Supabase REST API (integration_health table) --- {Dict[str, Any], json}
"""

from core.domain.repository_interfaces import IHealthRepository

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from ..persistence_gateway import SupabasePersistenceGateway

logger = logging.getLogger(__name__)


class HealthRepository(IHealthRepository):
    """
    Repository for persisting health status of integrations and services.
    """

    def __init__(self, db: SupabasePersistenceGateway):
        """
        Initialize health repository.

        Args:
            db: Supabase persistence gateway
        """
        self.db = db

    async def record_integration_health(
        self,
        name: str,
        status: str,
        error: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Record health status for an integration.

        Args:
            name: Integration name (e.g., 'docling', 'redis')
            status: Health status ('healthy', 'unhealthy')
            error: Optional error message
            metadata: Optional additional metrics
        """
        payload = {
            "name": name,
            "status": status,
            "last_checked": datetime.now(timezone.utc).isoformat(),
            "last_error": error,
            "metrics": metadata or {"watchdog": name, "status": status},
        }

        try:
            await self.db.upsert(
                "integration_health",
                payload,
                admin=True  # Health records are system-level
            )
            logger.debug(f"Recorded health for {name}: {status}")
        except Exception as e:
            logger.warning("Failed to record health for %s: %s", name, e)
            # We don't raise here to prevent monitoring from crashing the application

