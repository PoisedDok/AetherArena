"""
Proactive Agent Repository (DeepPlanning-Inspired)

Manages proactive_agent_runs and proactive_agent_queue tables.
Separate from old proactive.py (which handles proactive-IR pattern library).

@.architecture
Incoming: workers/handlers/proactive_agent_handler --- {Agent run data, queue items}
Processing: insert_agent_run(), queue_batch(), mark_shown(), record_feedback() --- {DB operations}
Outgoing: workers/handlers/proactive_agent_handler --- {Query results, stats}
"""

from core.domain.repository_interfaces import IProactiveAgentRepository

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

from ..clients.supabase import SupabaseClient
from ..persistence_gateway import SupabasePersistenceGateway

logger = logging.getLogger(__name__)


class ProactiveAgentRepository(IProactiveAgentRepository):
    """
    Repository for DeepPlanning-inspired proactive agent system.
    
    Manages:
    - proactive_agent_runs: Agent executions with decisions and feedback
    - proactive_agent_queue: Query batches awaiting processing
    
    Architecture Flow:
    1. Query gen daemon → SQLite (used_by_agent = 0)
    2. Worker creates queue entries for unprocessed queries
    3. Worker processes queue → calls agent → stores run
    4. Marks SQLite queries as used_by_agent = 1
    5. If intervene → shows to user → records feedback
    """
    
    def __init__(self, db=None):
        """Initialize repository with Supabase gateway."""
        if db is None:
            raise ValueError("SupabasePersistenceGateway required for ProactiveAgentRepository.")
        
        if isinstance(db, SupabasePersistenceGateway):
            self._gateway = db
        elif isinstance(db, SupabaseClient):
            self._gateway = SupabasePersistenceGateway(db)
        else:
            raise TypeError("Expected SupabasePersistenceGateway or SupabaseClient.")
        
        self.db = self._gateway
    
    # =========================================================================
    # PROACTIVE_AGENT_RUNS OPERATIONS
    # =========================================================================
    
    async def get_run_by_id(self, run_id: UUID) -> Optional[Dict[str, Any]]:
        """Fetch a specific agent run by ID."""
        runs = await self._gateway.select(
            "proactive_agent_runs",
            filters={"id": str(run_id)},
            limit=1,
        )
        return runs[0] if runs else None
    
    async def insert_agent_run(
        self,
        query_ids: List[str],
        queries: List[str],
        source_docs: List[Dict[str, Any]],
        day_date: str,
        decision: str,
        agent_mode: str = 'budget_0',
        llm_model: Optional[str] = None,
        tool_calls_count: Optional[int] = None,
        execution_time_ms: Optional[int] = None,
        relevance_score: Optional[float] = None,
        context_gathered: Optional[Any] = None,
        recommendation: Optional[str] = None,
        supporting_docs: Optional[List[Dict[str, Any]]] = None,
        reasoning_traces: Optional[List[str]] = None,
        session_id: Optional[UUID] = None,
        context_embedding: Optional[List[float]] = None,
        embedding_model: Optional[str] = None,
        defer_reason: Optional[str] = None,
        executed_tools: Optional[List[Any]] = None,
    ) -> Dict[str, Any]:
        """
        Insert agent run result.
        
        Args:
            query_ids: Query IDs from SQLite
            queries: Generated queries from Phase 1
            source_docs: Triggering activity documents
            day_date: Date queries were generated (YYYY-MM-DD)
            decision: 'intervene' or 'defer'
            agent_mode: Encodes classifier budget (e.g., budget_0..budget_4)
            llm_model: Model used (e.g., 'lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit')
            tool_calls_count: Number of tool calls made
            execution_time_ms: Execution time
            relevance_score: 0.0-1.0
            context_gathered: All tool outputs
            recommendation: If intervene
            supporting_docs: Top docs if intervene
            reasoning_traces: Agent thinking steps
            session_id: User session UUID
            context_embedding: Semantic embedding for similarity search
            embedding_model: Model that produced context_embedding
            defer_reason: Structured defer reasoning for ICL transparency
            
        Returns:
            Created agent run entry
        """
        normalized_agent_mode = agent_mode or "budget_0"

        data = {
            "query_ids": query_ids,
            "queries": queries,
            "source_docs": source_docs,
            "day_date": day_date,
            "agent_mode": normalized_agent_mode,
            "llm_model": llm_model,
            "tool_calls_count": tool_calls_count,
            "execution_time_ms": execution_time_ms,
            "decision": decision,
            "relevance_score": relevance_score,
            "context_gathered": context_gathered if context_gathered is not None else [],
            "recommendation": recommendation,
            "supporting_docs": supporting_docs or [],
            "reasoning_traces": reasoning_traces or [],
            "session_id": str(session_id) if session_id else None,
            "context_embedding": context_embedding,
            "embedding_model": embedding_model,
            "defer_reason": defer_reason,
            "executed_tools": executed_tools or [],
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
        
        try:
            logger.debug("Attempting insert to proactive_agent_runs (decision=%s, query_ids=%s)", decision, query_ids)
            
            result = await self._gateway.insert("proactive_agent_runs", data=data)
            
            logger.debug("Raw insert result type: %s", type(result).__name__)
            
            if isinstance(result, list):
                result = result[0]
            
            logger.info("Stored proactive run %s (decision=%s)", result['id'], decision)
            return result
            
        except Exception as e:
            logger.error("Failed to insert proactive agent run: %s", e, exc_info=True)
            raise
    
    async def mark_shown_to_user(self, run_id: UUID) -> None:
        """Mark agent run as shown to user."""
        await self._gateway.update(
            "proactive_agent_runs",
            record_id=str(run_id),
            data={"shown_to_user": True},
        )
    
    async def record_user_feedback(
        self,
        run_id: UUID,
        feedback: str,  # 'clicked' | 'dismissed' | 'timeout'
    ) -> None:
        """
        Record user feedback on proactive notification.
        
        CRITICAL: Also sets shown_to_user = True. If a user sends feedback
        (clicked/dismissed/timeout), the notification was definitively shown.
        The get_proactive_feedback_stats() SQL function filters on
        shown_to_user = TRUE, so this must be set here.
        
        Args:
            run_id: Agent run UUID
            feedback: User action ('clicked', 'dismissed', 'timeout')
        """
        await self._gateway.update(
            "proactive_agent_runs",
            record_id=str(run_id),
            data={
                "user_feedback": feedback,
                "feedback_timestamp": datetime.now(timezone.utc).isoformat(),
                "shown_to_user": True,
            },
        )

    async def get_run_by_id(self, run_id: UUID) -> Optional[Dict[str, Any]]:
        """Fetch a single proactive run by UUID."""
        rows = await self._gateway.select(
            "proactive_agent_runs",
            filters={"id": str(run_id)},
            limit=1,
        )
        if not rows:
            return None
        return rows[0]
        
    async def get_latest_unseen_intervention(self, hours: int = 1) -> Optional[Dict[str, Any]]:
        """
        Get the latest proactive intervention that the user hasn't seen/interacted with.
        
        Args:
            hours: Look back this many hours (default: 1)
            
        Returns:
            The latest unseen agent run, or None if none found
        """
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        
        runs = await self._gateway.select(
            "proactive_agent_runs",
            filters={"decision": "intervene"},
            order_by="created_at.desc",
            limit=10,
        )
        for run in runs:
            created_at_str = run.get("created_at")
            if not created_at_str:
                continue
            created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
            if created_at < cutoff:
                continue
            if not run.get("user_feedback"):
                return run
        return None
    
    async def get_recent_runs(
        self,
        decision: Optional[str] = None,
        days: int = 7,
        limit: int = 100,
        columns: str = "*",
    ) -> List[Dict[str, Any]]:
        """
        Get recent agent runs.
        
        Args:
            decision: Filter by 'intervene' or 'defer'
            days: Look back this many days
            limit: Max results
            columns: Specific columns to fetch (default: "*")
            
        Returns:
            List of agent runs
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        
        filters = {"created_at": {"gte": cutoff.isoformat()}}
        if decision:
            filters["decision"] = decision
        
        return await self._gateway.select(
            "proactive_agent_runs",
            columns=columns,
            filters=filters,
            order_by="created_at.desc",
            limit=limit,
        )
    
    async def find_similar_runs(
        self,
        queries: List[str],
        similarity_threshold: int = 1,
        limit: int = 10,
    ) -> List[Dict[str, Any]]:
        """
        Find similar past agent runs by query text matching (legacy method).
        
        Args:
            queries: Input queries to match
            similarity_threshold: Min matching queries
            limit: Max results
            
        Returns:
            List of similar runs with match count
        """
        # Simple filter: client-side filtering is sufficient for typical result
        # set sizes (< 100 rows). RPC-based approach reserved for scale-out.
        return await self._gateway.select(
            "proactive_agent_runs",
            filters=None,  # Would use custom RPC
            order_by="created_at.desc",
            limit=limit,
        )
    
    async def search_similar_runs(
        self,
        query_embedding: List[float],
        similarity_threshold: float = 0.7,
        require_positive_feedback: bool = True,
        limit: int = 5,
        embedding_model: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Search similar past agent runs using semantic embeddings (for ICL).
        
        This method finds historical proactive agent runs with similar context
        using vector similarity search. Results include user feedback labels
        for In-Context Learning (ICL) integration.
        
        Args:
            query_embedding: Embedding vector of current context (384-dim for Xenova/bge-small-en-v1.5)
            similarity_threshold: Min cosine similarity (0.0-1.0, default: 0.7)
            require_positive_feedback: Only return runs user clicked (default: True)
            limit: Max results (default: 5)
            embedding_model: Only compare against runs with this model (D1 fix).
                None means compare against all runs (backward compat).
            
        Returns:
            List of similar runs with:
            - run_id: UUID of historical run
            - similarity_score: Cosine similarity (0.0-1.0)
            - decision: 'intervene' or 'defer'
            - recommendation: Agent's response text
            - user_feedback: 'clicked', 'dismissed', 'timeout'
            - created_at: Timestamp
        
        Usage:
            similar_runs = await repo.search_similar_runs(
                query_embedding=context_embedding,
                embedding_model="Xenova/bge-small-en-v1.5",
                require_positive_feedback=True,
                limit=3,
            )
        """
        try:
            # Call search_similar_proactive_runs() SQL function
            result = await self._gateway.rpc(
                "search_similar_proactive_runs",
                params={
                    "query_embedding": query_embedding,
                    "similarity_threshold": similarity_threshold,
                    "require_positive_feedback": require_positive_feedback,
                    "limit_results": limit,
                    "embedding_model_name": embedding_model,
                },
            )
            return result or []
        except Exception as e:
            logger.error(f"Failed to search similar proactive runs: {e}")
            return []
    
    async def get_feedback_stats(self, days: int = 7) -> Dict[str, Any]:
        """
        Get user feedback statistics for learning.
        
        Calls get_proactive_feedback_stats() SQL function which returns:
        total_shown, clicked_count, dismissed_count, timeout_count, click_rate.
        
        Args:
            days: Look back this many days
            
        Returns:
            Stats dict with feedback counts and click rate
        """
        try:
            result = await self._gateway.rpc(
                "get_proactive_feedback_stats",
                params={"days_back": days},
            )
            if result and len(result) > 0:
                row = result[0] if isinstance(result, list) else result
                # Use `or 0` pattern: row.get("key", default) returns None when
                # the key exists with a SQL NULL value — the default only applies
                # when the key is absent entirely. float(None) raises TypeError.
                return {
                    "total_shown": row.get("total_shown") or 0,
                    "clicked_count": row.get("clicked_count") or 0,
                    "dismissed_count": row.get("dismissed_count") or 0,
                    "timeout_count": row.get("timeout_count") or 0,
                    "click_rate": float(row.get("click_rate") or 0.0),
                }
        except Exception as e:
            logger.error(f"Failed to get feedback stats: {e}")
        
        return {
            "total_shown": 0,
            "clicked_count": 0,
            "dismissed_count": 0,
            "timeout_count": 0,
            "click_rate": 0.0,
        }
    
    # =========================================================================
    # PROACTIVE_AGENT_QUEUE OPERATIONS
    # =========================================================================
    
    async def queue_batch(
        self,
        query_ids: List[str],
        day_date: str,
        priority: int = 5,
    ) -> Dict[str, Any]:
        """
        Queue query batch for processing.
        
        Args:
            query_ids: Query IDs from SQLite to process
            day_date: Date these queries were generated
            priority: Higher = more urgent (5 = normal)
            
        Returns:
            Created queue entry
        """
        data = {
            "query_ids": query_ids,
            "day_date": day_date,
            "priority": priority,
            "status": "pending",
        }
        
        result = await self._gateway.insert("proactive_agent_queue", data=data)
        return result[0] if result else {}
    
    async def get_pending_batches(
        self,
        limit: int = 10,
    ) -> List[Dict[str, Any]]:
        """
        Get pending query batches for processing.
        
        Args:
            limit: Max batches to return
            
        Returns:
            List of pending queue entries (ordered by priority, then age)
        """
        return await self._gateway.select(
            "proactive_agent_queue",
            filters={"status": "pending"},
            order_by="priority.desc,created_at.asc",
            limit=limit,
        )
    
    async def mark_batch_processing(self, queue_id: UUID) -> None:
        """Mark queue batch as processing."""
        await self._gateway.update(
            "proactive_agent_queue",
            record_id=str(queue_id),
            data={
                "status": "processing",
                "started_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    
    async def mark_batch_completed(
        self,
        queue_id: UUID,
        agent_run_id: UUID,
    ) -> None:
        """
        Mark queue batch as completed.
        
        Args:
            queue_id: Queue entry UUID
            agent_run_id: Created agent run UUID
        """
        await self._gateway.update(
            "proactive_agent_queue",
            record_id=str(queue_id),
            data={
                "status": "completed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "agent_run_id": str(agent_run_id),
            },
        )
    
    async def mark_batch_failed(
        self,
        queue_id: UUID,
        error_message: str,
    ) -> None:
        """
        Mark queue batch as failed.
        
        Args:
            queue_id: Queue entry UUID
            error_message: Error description
        """
        # Increment retry count
        queue_entry = await self._gateway.select(
            "proactive_agent_queue",
            filters={"id": str(queue_id)},
            limit=1,
        )
        
        if not queue_entry:
            return
        
        retry_count = queue_entry[0].get("retry_count", 0) + 1
        
        await self._gateway.update(
            "proactive_agent_queue",
            record_id=str(queue_id),
            data={
                "status": "failed" if retry_count >= 3 else "pending",  # Retry up to 3 times
                "error_message": error_message,
                "retry_count": retry_count,
            },
        )
    
    async def get_queue_stats(self) -> Dict[str, Any]:
        """
        Get queue statistics for monitoring.
        
        Returns:
            Stats dict with pending/processing/failed counts
        """
        try:
            result = await self._gateway.rpc(
                "get_proactive_queue_stats",
                params={},
            )
            if result and len(result) > 0:
                row = result[0] if isinstance(result, list) else result
                return {
                    "pending_count": row.get("pending_count", 0),
                    "processing_count": row.get("processing_count", 0),
                    "failed_count": row.get("failed_count", 0),
                    "oldest_pending": row.get("oldest_pending"),
                }
        except Exception as e:
            logger.error(f"Failed to get queue stats: {e}")
        
        return {
            "pending_count": 0,
            "processing_count": 0,
            "failed_count": 0,
            "oldest_pending": None,
        }
