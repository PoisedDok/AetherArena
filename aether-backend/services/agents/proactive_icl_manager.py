"""
Proactive ICL Manager

Manages a AETHER_RAG index of past proactive agent runs for In-Context Learning (ICL).
Follows the AgentAetherRagManager pattern (same constructor, same index lifecycle).

Hybrid search (semantic + BM25 + RRF) retrieves similar past interventions.
Composite ranking (relevance > time > frequency > feedback) produces a ranked list
for the scout LLM to reason about clicked vs dismissed patterns.

@.architecture
Incoming: api/v1/endpoints/proactive.py --- {run data, search queries}
Processing: build/search ICL index, composite ranking --- {3 jobs: BUILD, SEARCH, RANK}
Outgoing: api/v1/endpoints/proactive.py --- {ranked ICL examples for scout prompt}
"""

import logging
import math
import json
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

FEEDBACK_SCORES = {
    "clicked": 1.0,     # Strong positive signal
    "dismissed": 1.0,   # Strong negative signal (equally useful for learning what NOT to do)
    "timeout": 0.5,     # Weak signal (user may have just ignored it)
}

INDEX_NAME = "proactive_icl"
ICL_META_KEY = "_proactive_icl"
ICL_META_SCHEMA_VERSION = 1

from application.indexing.aether_rag_service import AetherRagService

# Global cache for searcher to prevent OOM loops on concurrent ICL queries
# (Removed in favor of AetherRagService unified cache)


class ProactiveICLManager:
    """
    Manages a AETHER_RAG index of proactive agent runs for ICL retrieval.

    Index stores: recommendation + queries as text, with feedback/timestamp metadata.
    Search returns semantically + keyword-similar past interventions.
    Composite ranking orders results by: relevance > recency > frequency > feedback.
    """

    _build_lock = None  # Class-level asyncio.Lock initialized lazily
    _thread_lock = None # Class-level threading.Lock initialized lazily

    @classmethod
    def get_lock(cls) -> "asyncio.Lock":
        import asyncio
        if cls._build_lock is None:
            cls._build_lock = asyncio.Lock()
        return cls._build_lock

    @classmethod
    def get_thread_lock(cls):
        import threading
        if cls._thread_lock is None:
            cls._thread_lock = threading.Lock()
        return cls._thread_lock

    def __init__(
        self,
        index_directory: Path,
        embedding_model: str,
        mode: str = "openai",
        api_base: Optional[str] = None,
        api_key: Optional[str] = None,
    ):
        self.index_directory = Path(index_directory)
        self.embedding_model = embedding_model
        self.mode = mode
        self.api_base = api_base
        self.api_key = api_key or "not-needed"
        
        self.service = AetherRagService(
            embedding_model=self.embedding_model,
            api_base=self.api_base,
            api_key=self.api_key
        )

        self.index_directory.mkdir(parents=True, exist_ok=True)

        self._index_path = self.index_directory / f"{INDEX_NAME}.aether_rag"
        self._meta_path = Path(f"{self._index_path}.meta.json")
        self._building = False

        logger.info(
            "Initialized ProactiveICLManager: model=%s, mode=%s, api_base=%s, index_dir=%s",
            embedding_model, mode, api_base, self.index_directory,
        )

    @property
    def _provider_options(self) -> Optional[Dict[str, str]]:
        if self.mode == "openai" and self.api_base:
            return {"base_url": self.api_base, "api_key": self.api_key}
        return None

    def _make_document_text(self, recommendation: str, queries: List[str]) -> str:
        """Combine recommendation and queries into a single indexable document."""
        queries_text = " ".join(q for q in queries if q)
        return f"{recommendation} | {queries_text}".strip(" |")

    def _read_meta(self) -> Dict[str, Any]:
        """Read AETHER_RAG meta JSON safely."""
        if not self._meta_path.exists():
            return {}
        try:
            with open(self._meta_path, "r") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception as e:
            logger.warning("Failed reading ICL meta file %s: %s", self._meta_path, e)
            return {}

    def _write_meta(self, meta: Dict[str, Any]) -> None:
        """Write AETHER_RAG meta JSON safely."""
        with open(self._meta_path, "w") as f:
            json.dump(meta, f, indent=2)

    def _read_icl_meta(self) -> Dict[str, Any]:
        """Read custom proactive metadata section from AETHER_RAG meta JSON."""
        meta = self._read_meta()
        icl_meta = meta.get(ICL_META_KEY, {})
        return icl_meta if isinstance(icl_meta, dict) else {}

    def _update_icl_meta(self, **updates: Any) -> None:
        """Merge/update custom proactive metadata section."""
        meta = self._read_meta()
        icl_meta = meta.get(ICL_META_KEY, {})
        if not isinstance(icl_meta, dict):
            icl_meta = {}
        icl_meta.update(updates)
        meta[ICL_META_KEY] = icl_meta
        self._write_meta(meta)

    def _meta_requires_rebuild(self) -> bool:
        """
        Determine whether index should be rebuilt due to metadata drift.

        Rebuild conditions:
        - Missing/invalid meta
        - BM25 disabled (hybrid mode would degrade)
        - Missing custom proactive metadata stamp
        - Embedding model/mode mismatch
        - Schema version mismatch
        """
        if not self._meta_path.exists():
            return True

        meta = self._read_meta()
        if not meta:
            return True

        bm25_enabled = bool(meta.get("bm25_enabled", False) or meta.get("enable_bm25", False))
        if not bm25_enabled:
            logger.info("ICL index rebuild required: BM25 disabled in existing index metadata")
            return True

        icl_meta = self._read_icl_meta()
        if not icl_meta:
            logger.info("ICL index rebuild required: proactive metadata stamp missing")
            return True

        if icl_meta.get("schema_version") != ICL_META_SCHEMA_VERSION:
            logger.info(
                "ICL index rebuild required: schema version mismatch (%s != %s)",
                icl_meta.get("schema_version"),
                ICL_META_SCHEMA_VERSION,
            )
            return True

        if icl_meta.get("embedding_model") != self.embedding_model:
            logger.info(
                "ICL index rebuild required: embedding model mismatch (%s != %s)",
                icl_meta.get("embedding_model"),
                self.embedding_model,
            )
            return True

        if icl_meta.get("embedding_mode") != self.mode:
            logger.info(
                "ICL index rebuild required: embedding mode mismatch (%s != %s)",
                icl_meta.get("embedding_mode"),
                self.mode,
            )
            return True

        return False

    def build_from_runs(self, runs: List[Dict[str, Any]]) -> bool:
        """
        Build a fresh AETHER_RAG index from historical proactive agent runs.

        Args:
            runs: List of run dicts from Supabase (must have recommendation, queries,
                  user_feedback, created_at, id).

        Returns:
            True if index built successfully, False otherwise.
        """
        lock = self.get_thread_lock()
        if not lock.acquire(blocking=False):
            logger.warning("Index build already in progress (thread locked), skipping")
            return False

        try:
            valid_runs = [
                r for r in runs
                if r.get("recommendation") and r.get("user_feedback")
            ]

            if not valid_runs:
                logger.info("No runs with feedback to index")
                return False

            chunks = []
            indexed_run_ids: List[str] = []
            for run in valid_runs:
                text = self._make_document_text(
                    run.get("recommendation", ""),
                    run.get("queries", []),
                )
                if len(text.strip()) < 10:
                    continue

                run_id = str(run.get("id", ""))
                metadata = {
                    "id": run_id,
                    "run_id": run_id,
                    "feedback": run.get("user_feedback", "unknown"),
                    "timestamp": run.get("created_at", ""),
                }
                chunks.append({"text": text, "metadata": metadata})
                if run_id:
                    indexed_run_ids.append(run_id)

            if not chunks:
                logger.info("No valid documents to index after filtering")
                return False

            self.service._build_index_sync(
                index_directory=self.index_directory,
                index_name=INDEX_NAME,
                chunks=chunks,
                index_mode="combined",
                incremental=False
            )

            self._update_icl_meta(
                schema_version=ICL_META_SCHEMA_VERSION,
                embedding_model=self.embedding_model,
                embedding_mode=self.mode,
                indexed_run_ids=indexed_run_ids,
                indexed_count=len(chunks),
                last_sync_at=datetime.now(timezone.utc).isoformat(),
            )
            logger.info("Built ICL index with %d documents at %s", len(chunks), self._index_path)
            return True

        except Exception as e:
            logger.error("Failed to build ICL index: %s", e, exc_info=True)
            return False
        finally:
            lock.release()

    def search(
        self,
        query: str,
        top_k: int = 10,
        mode: str = "hybrid",
    ) -> List[Dict[str, Any]]:
        """
        Search past interventions using AETHER_RAG hybrid search (semantic + BM25 + RRF).

        Args:
            query: Current context text to find similar past interventions.
            top_k: Number of results to return.
            mode: Search mode ('hybrid', 'semantic', 'bm25').

        Returns:
            List of dicts with 'text', 'score', 'metadata' keys.
        """
        try:
            if not self._meta_path.exists():
                logger.info("ICL index does not exist yet (no meta at %s)", self._meta_path)
                return []

            results = self.service._search_sync(
                index_directory=self.index_directory,
                index_name=INDEX_NAME,
                query=query,
                top_k=top_k,
                mode=mode
            )

            logger.info(
                "ICL search (mode=%s): %d results for '%s'",
                mode, len(results), query[:60],
            )
            return results

        except Exception as e:
            logger.error("ICL search failed: %s", e, exc_info=True)
            return []

    def rank_with_composite(
        self,
        results: List[Dict[str, Any]],
        current_time: datetime,
    ) -> List[Dict[str, Any]]:
        """
        Apply composite ranking to AETHER_RAG search results.

        Formula:
            composite = 0.4 * relevance + 0.3 * recency + 0.2 * frequency + 0.1 * feedback

        Where:
            - relevance: RRF score normalized to [0, 1]
            - recency: exp(-0.049 * days_since_run), half-life ~14 days
            - frequency: count of same-topic results normalized to [0, 1]
            - feedback: clicked=1.0, timeout=0.5, dismissed=0.0

        Args:
            results: Output from self.search(), each dict has 'text', 'score', 'metadata'.
            current_time: Reference time for recency calculation.

        Returns:
            Same results, sorted by composite score descending, with 'composite_score'
            and 'days_ago' added to each result's metadata.
        """
        if not results:
            return []

        scores = [r.get("score", 0.0) for r in results]
        max_score = max(scores) if scores else 1.0
        min_score = min(scores) if scores else 0.0
        score_range = max_score - min_score

        # Count frequency: how many results share similar recommendation text
        # (using first 50 chars of recommendation as a rough topic key)
        topic_counts: Dict[str, int] = {}
        for r in results:
            text = r.get("text", "")
            topic_key = text[:50].lower().strip()
            topic_counts[topic_key] = topic_counts.get(topic_key, 0) + 1
        max_freq = max(topic_counts.values()) if topic_counts else 1

        ranked = []
        for r in results:
            meta = r.get("metadata", {})
            raw_score = r.get("score", 0.0)

            # Relevance: normalize to [0, 1]
            relevance = (raw_score - min_score) / score_range if score_range > 0 else 1.0

            # Recency: time decay with ~14-day half-life
            days_ago = 0.0
            timestamp_str = meta.get("timestamp", "")
            if timestamp_str:
                try:
                    ts = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    days_ago = max(0.0, (current_time - ts).total_seconds() / 86400.0)
                except (ValueError, TypeError):
                    pass
            recency = math.exp(-0.049 * days_ago)

            # Frequency: normalized topic occurrence count
            text = r.get("text", "")
            topic_key = text[:50].lower().strip()
            freq_count = topic_counts.get(topic_key, 1)
            frequency = freq_count / max_freq if max_freq > 0 else 0.0

            # Feedback: direct mapping (both clicked and dismissed provide strong utility signal)
            # Timeout provides less utility signal.
            feedback_label = meta.get("feedback", "unknown")
            feedback_score = FEEDBACK_SCORES.get(feedback_label, 0.3)

            composite = (
                0.40 * relevance
                + 0.25 * recency
                + 0.15 * frequency
                + 0.20 * feedback_score
            )

            enriched = dict(r)
            enriched_meta = dict(meta)
            enriched_meta["days_ago"] = round(days_ago, 1)
            enriched["metadata"] = enriched_meta
            enriched["composite_score"] = round(composite, 4)
            ranked.append(enriched)

        ranked.sort(key=lambda x: x["composite_score"], reverse=True)
        return ranked

    async def ensure_index(self, repo: Any, force_rebuild: bool = False) -> bool:
        """
        Lazy initialization: build index from Supabase runs if it doesn't exist.

        Checks for the index meta file. If missing, fetches all runs with feedback
        from the repository and builds the index. If already present, returns True.

        Args:
            repo: ProactiveAgentRepository instance (has get_recent_runs method).

        Returns:
            True if index exists (or was just built), False if no data or build failed.
        """
        rebuild_required = force_rebuild or self._meta_requires_rebuild()

        if self._meta_path.exists() and not rebuild_required:
            return True

        lock = self.get_lock()
        if lock.locked():
            logger.info("ICL index build already in progress (locked)")
            return False

        import asyncio
        async with lock:
            # Re-check condition inside lock to prevent race conditions
            rebuild_required = force_rebuild or self._meta_requires_rebuild()
            if self._meta_path.exists() and not rebuild_required:
                return True

            try:
                if force_rebuild:
                    logger.info("Forcing proactive ICL rebuild from repository feedback data")
                elif self._meta_path.exists():
                    logger.info("Rebuilding proactive ICL index due to metadata drift")

                # Fetch all intervention runs (no day limit — ICL needs full history)
                # Only fetch the columns we actually need to avoid Supabase statement timeouts
                # caused by pulling down massive JSONB payloads (source_docs, context_gathered, etc.)
                runs = await repo.get_recent_runs(
                    decision="intervene", 
                    days=365, 
                    limit=1000,
                    columns="id, recommendation, queries, user_feedback, created_at"
                )

                # Filter to runs with feedback (client-side, small dataset)
                runs_with_feedback = [
                    r for r in runs
                    if r.get("user_feedback") and r.get("recommendation")
                ]

                if not runs_with_feedback:
                    logger.info("No runs with feedback found — ICL index cannot be built yet (cold start)")
                    return False

                # Cross-process file locking to prevent JSONDecodeError corruption
                # when API server and Background Worker hit the index simultaneously.
                import filelock
                lock_file = self._index_path.with_suffix(".lock")
                
                def _build_with_lock():
                    with filelock.FileLock(str(lock_file), timeout=60):
                        return self.build_from_runs(runs_with_feedback)

                # Run CPU-intensive build in a thread pool to avoid blocking the event loop
                return await asyncio.to_thread(_build_with_lock)

            except Exception as e:
                logger.error("Failed to ensure ICL index: %s", e, exc_info=True)
                return False

    def append_run(
        self,
        recommendation: str,
        queries: List[str],
        feedback: str,
        timestamp: str,
        run_id: str = "",
    ) -> bool:
        """
        Incrementally append a new run to the existing ICL index.

        Uses HNSW non-compact mode (is_compact=False) which supports update_index.

        Args:
            recommendation: Agent's recommendation text.
            queries: Original queries that triggered the run.
            feedback: User feedback ('clicked', 'dismissed', 'timeout').
            timestamp: ISO timestamp of the run.
            run_id: UUID string of the run.

        Returns:
            True if appended successfully, False otherwise.
        """
        lock = self.get_thread_lock()
        with lock:
            try:
                if not self._meta_path.exists():
                    logger.info("ICL index does not exist — cannot append. Use ensure_index first.")
                    return False

                if self._meta_requires_rebuild():
                    logger.warning("ICL metadata drift detected before append; skipping append and requiring rebuild")
                    return False

                icl_meta = self._read_icl_meta()
                indexed_run_ids = set(icl_meta.get("indexed_run_ids", [])) if isinstance(icl_meta.get("indexed_run_ids"), list) else set()
                if run_id and run_id in indexed_run_ids:
                    logger.info("Run %s already indexed in ICL; append skipped", run_id)
                    return False

                text = self._make_document_text(recommendation, queries)
                if len(text.strip()) < 10:
                    logger.warning("Run text too short to index: '%s'", text[:30])
                    return False

                metadata = {
                    "id": run_id,
                    "run_id": run_id,
                    "feedback": feedback,
                    "timestamp": timestamp,
                }

                # Cross-process file locking to prevent JSONDecodeError corruption
                # when API server and Background Worker hit the index simultaneously.
                import filelock
                lock_file = self._index_path.with_suffix(".lock")
                with filelock.FileLock(str(lock_file), timeout=30):
                    chunks = [{"text": text, "metadata": metadata}]
                    
                    # We pass incremental=True which will update the existing index
                    # Note: We rely on the AetherRagService to assign proper chunk indices. 
                    # If FAISS needs specific IDs, AetherRagBuilder handles it internally.
                    self.service._build_index_sync(
                        index_directory=self.index_directory,
                        index_name=INDEX_NAME,
                        chunks=chunks,
                        index_mode="combined",
                        incremental=True
                    )

                    if run_id:
                        indexed_run_ids.add(run_id)
                    self._update_icl_meta(
                        schema_version=ICL_META_SCHEMA_VERSION,
                        embedding_model=self.embedding_model,
                        embedding_mode=self.mode,
                        indexed_run_ids=sorted(indexed_run_ids),
                        indexed_count=len(indexed_run_ids),
                        last_sync_at=datetime.now(timezone.utc).isoformat(),
                    )

                logger.info("Appended run %s to ICL index (feedback=%s)", run_id, feedback)
                return True

            except Exception as e:
                logger.error("Failed to append run to ICL index: %s", e, exc_info=True)
                return False


def get_proactive_icl_manager(
    index_directory: Optional[Path] = None,
    embedding_model: Optional[str] = None,
) -> ProactiveICLManager:
    """
    Factory function to get ProactiveICLManager with defaults from settings.

    Follows the same factory pattern as get_agent_aether_rag_manager().
    """
    from config.settings import get_settings

    settings = get_settings()

    if index_directory is None:
        import os
        backend_root_env = os.environ.get("AETHER_BACKEND_ROOT")
        if backend_root_env:
            backend_root = Path(backend_root_env)
        else:
            backend_root = Path(__file__).parent.parent.parent
        index_directory = backend_root / "data" / "indexes" / "proactive_icl"

    if embedding_model is None:
        embedding_model = settings.embedding_service.model

    return ProactiveICLManager(
        index_directory=index_directory,
        embedding_model=embedding_model,
        mode="openai",
        api_base=settings.embedding_service.openai_base_url,
        api_key="not-needed",
    )
