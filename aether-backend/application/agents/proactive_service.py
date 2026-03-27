"""
Proactive Agent Service

Encapsulates logic for proactive agent database interactions.
"""

from core.domain.repository_interfaces import IProactiveAgentRepository
from typing import Optional, Dict, Any
from uuid import UUID
from datetime import datetime, timezone

from config.settings import Settings
from monitoring import get_logger

logger = get_logger(__name__)

class ProactiveService:
    def __init__(
        self,
        settings: Settings,
        proactive_repo: IProactiveAgentRepository
    ):
        self._settings = settings
        self._proactive_repo = proactive_repo

    async def record_user_feedback(self, run_id: str, feedback: str) -> bool:
        """
        Record user feedback for a proactive notification (Phase 3 - Final Feedback).
        Also triggers ICL background refresh.
        """
        try:
            run_uuid = UUID(run_id)
            await self._proactive_repo.record_user_feedback(run_uuid, feedback)
            logger.info("Recorded feedback '%s' for run %s", feedback, run_id)
            return True
        except ValueError:
            logger.info("Test run feedback '%s' for %s (not persisted)", feedback, run_id)
            return False

    async def get_run_by_id(self, run_id: UUID) -> Optional[Dict[str, Any]]:
        return await self._proactive_repo.get_run_by_id(run_id)

    async def get_latest_unseen(self) -> Optional[Dict[str, Any]]:
        """Recover missed notifications on startup or reconnect."""
        return await self._proactive_repo.get_latest_unseen_intervention(hours=1)

    async def get_stats(self, days: int = 7) -> Dict[str, Any]:
        """Get proactive agent statistics for monitoring and tuning."""
        runs = await self._proactive_repo.get_recent_runs(days=days, limit=1000)
        feedback_stats = await self._proactive_repo.get_feedback_stats(days=days)
        
        total_runs = len(runs)
        intervene_count = sum(1 for r in runs if r.get("decision") == "intervene")
        defer_count = total_runs - intervene_count
        
        avg_tool_calls = sum(r.get("tool_calls_count", 0) or 0 for r in runs) / total_runs if total_runs > 0 else 0
        
        return {
            "period_days": days,
            "total_runs": total_runs,
            "intervene_count": intervene_count,
            "defer_count": defer_count,
            "avg_tool_calls": round(avg_tool_calls, 2),
            "feedback": feedback_stats,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

    async def rebuild_icl_index_bg(self) -> None:
        """Background task to rebuild ICL index."""
        try:
            from services.agents.proactive_icl_manager import get_proactive_icl_manager
            icl_manager = get_proactive_icl_manager()
            await icl_manager.ensure_index(self._proactive_repo, force_rebuild=True)
            logger.info("Background ICL index rebuild completed successfully.")
        except Exception as e:
            logger.error("Background ICL index rebuild failed: %s", e)


    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
