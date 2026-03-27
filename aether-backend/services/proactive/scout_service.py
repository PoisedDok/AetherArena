"""
Proactive Scout Service

Domain logic for executing proactive agent scouting (Phase 2 of DeepPlanning architecture).
Extracted from endpoints to allow direct invocation from the background worker without HTTP overhead.
"""

import asyncio
import httpx
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from uuid import UUID, uuid4

from core.exceptions import DomainException
from fastapi import HTTPException, status
from config.settings import Settings
from data.database.persistence_gateway import SupabasePersistenceGateway
from monitoring import get_logger

logger = get_logger(__name__)


async def call_perplexica_proactive_agent(
    queries: List[str],
    source_docs: List[Dict[str, Any]],
    settings: Settings,
    icl_examples: Optional[List[Dict[str, Any]]] = None,
    trace_id: Optional[str] = None,
    max_processing_time_seconds: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Call Perplexica proactive agent to scout and decide on intervention.
    
    Args:
        queries: Generated queries from Phase 1
        source_docs: Triggering activity documents
        settings: Application settings
        icl_examples: Pre-fetched ICL examples from similar past runs (Phase 4)
        
    Returns:
        Dict with agent output (decision, recommendation, context, etc.)
    """
    effective_trace_id = trace_id or f"proactive-{uuid4().hex}"
    try:
        perplexica_url = settings.integrations.perplexica_url.rstrip("/")
        endpoint = f"{perplexica_url}/api/proactive/scout"
        
        # ========================================================================
        # CONTEXT SEPARATION: Split current triggers from previous queries
        # ========================================================================
        current_activity = []
        background_history = []
        
        for doc in source_docs:
            metadata = doc.get("metadata", {})
            context_type = metadata.get("_context_type", "unknown")
            batch = metadata.get("_batch", "unknown")
            timestamp = doc.get("timestamp", metadata.get("timestamp", ""))
            
            doc_with_time = {**doc, "timestamp": timestamp}
            
            if context_type == "triggering_log" and batch == "current":
                current_activity.append(doc_with_time)
            elif context_type == "previous_query":
                background_history.append(doc_with_time)
            else:
                pass
        
        logger.info(
            f"Context split: {len(current_activity)} current triggers, "
            f"{len(background_history)} previous queries (no old docs)"
        )
        
        agent_model_id = settings.inference.default_model or settings.llm.model
        logger.info("Proactive agent model: %s", agent_model_id)
        
        import json
        def _serialize_numpy(obj):
            type_name = type(obj).__name__
            if "float" in type_name: return float(obj)
            if "int" in type_name: return int(obj)
            return str(obj)

        raw_payload = {
            "queries": queries,
            "traceId": effective_trace_id,
            "currentActivity": current_activity,
            "backgroundHistory": background_history,
            "iclExamples": icl_examples or [],
            "chatModel": {
                "providerId": "aether-inference-default",
                "key": agent_model_id,
            },
            "config": {
                "apiBase": settings.mesh_base_url,
                "maxProcessingTimeSeconds": max_processing_time_seconds,
            }
        }
        # Sanitize float32 and other numpy types for JSON serialization
        payload = json.loads(json.dumps(raw_payload, default=_serialize_numpy))
        
        logger.info(
            "Calling Perplexica proactive agent [trace_id=%s]: %s (queries=%d, current=%d, background=%d, icl=%d)",
            effective_trace_id,
            endpoint,
            len(queries),
            len(current_activity),
            len(background_history),
            len(icl_examples or []),
        )

        configured_timeout = (
            float(max_processing_time_seconds)
            if max_processing_time_seconds is not None
            else float(settings.proactive.agent_worker.max_processing_time_seconds)
        )
        total_timeout_seconds = max(5.0, min(configured_timeout, 600.0))
        connect_timeout_seconds = max(3.0, min(15.0, total_timeout_seconds / 6.0))
        timeout = httpx.Timeout(total_timeout_seconds, connect=connect_timeout_seconds)
        
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                endpoint,
                json=payload,
                headers={"X-Trace-Id": effective_trace_id},
            )
            response.raise_for_status()
            
            result = response.json()
            logger.info(
                "Proactive agent decision [trace_id=%s]: %s, tool_budget: %s",
                effective_trace_id,
                result.get('decision'),
                result.get('toolBudget', 0),
            )
            result.setdefault("traceId", effective_trace_id)
            
            return result

    except httpx.TimeoutException as e:
        logger.error(
            "Perplexica proactive timeout [trace_id=%s, timeout=%.1fs]: %s",
            effective_trace_id,
            total_timeout_seconds,
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={
                "error": "Proactive agent timeout",
                "trace_id": effective_trace_id,
                "timeout_seconds": total_timeout_seconds,
            },
        )
    except httpx.ConnectError as e:
        logger.error(
            "Perplexica proactive connection failed [trace_id=%s]: %s",
            effective_trace_id,
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "Proactive agent unavailable",
                "trace_id": effective_trace_id,
            },
        )
    except httpx.HTTPStatusError as e:
        upstream_status = e.response.status_code
        upstream_body = (e.response.text or "")[:400]
        logger.error(
            "Perplexica proactive upstream status error [trace_id=%s, status=%d]: %s",
            effective_trace_id,
            upstream_status,
            upstream_body,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE if upstream_status >= 500 else status.HTTP_502_BAD_GATEWAY,
            detail={
                "error": "Proactive agent upstream error",
                "trace_id": effective_trace_id,
                "upstream_status": upstream_status,
                "upstream_body": upstream_body,
            },
        )
    except httpx.HTTPError as e:
        logger.error(
            "Perplexica proactive HTTP error [trace_id=%s]: %s",
            effective_trace_id,
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "Proactive agent HTTP error",
                "trace_id": effective_trace_id,
            },
        )
    except Exception as e:
        logger.error(
            "Proactive agent error [trace_id=%s]: %s",
            effective_trace_id,
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "Proactive agent error",
                "trace_id": effective_trace_id,
            },
        )


async def execute_proactive_scout(
    query_ids: List[str],
    queries: List[str],
    source_docs: List[Dict[str, Any]],
    day_date: str,
    settings: Settings,
    gateway: SupabasePersistenceGateway,
    session_id: Optional[UUID] = None,
    trace_id: Optional[str] = None,
    max_processing_time_seconds: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Execute proactive agent scouting (Phase 2).
    
    1. Call Perplexica proactive ReAct agent for decision-making
    2. Store results in proactive_agent_runs table
    3. Return decision + recommendation
    """
    start_time = asyncio.get_running_loop().time()
    effective_trace_id = trace_id or f"proactive-{uuid4().hex}"
    
    logger.info(
        "Proactive scout execution started [trace_id=%s, query_count=%d, source_docs=%d]",
        effective_trace_id,
        len(queries),
        len(source_docs),
    )
    
    try:
        # ====================================================================================
        # PHASE 4 ENHANCEMENT: Pre-fetch ICL Examples
        # ====================================================================================
        context_parts = []
        
        def _sanitize_context(text: str) -> str:
            if not isinstance(text, str):
                return str(text)
            # Remove characters that could break the structural pipe format
            return text.replace(" | ", " ").replace("[", "(").replace("]", ")")
        
        for source_doc in source_docs:
            source_type = source_doc.get("source", "unknown").upper()
            metadata = source_doc.get("metadata", {})
            
            if source_type == "EMAIL":
                subject = metadata.get("subject", "")
                from_addr = metadata.get("from", "")
                meta_str = f"Subject: {subject}" if subject else f"From: {from_addr}" if from_addr else "Email"
            elif source_type == "FILESYSTEM":
                file_name = metadata.get("file_name", metadata.get("path", "File"))
                meta_str = f"File: {file_name}"
            elif source_type == "BROWSER":
                title = metadata.get("title", metadata.get("url", "Page"))
                meta_str = f"Page: {title}"
            elif source_type == "ACTIVE_WINDOWS":
                window_title = metadata.get("window_title", metadata.get("app_name", "Window"))
                meta_str = f"Window: {window_title}"
            elif source_type == "QUERY_GEN":
                query_text = metadata.get("query", metadata.get("title", ""))
                meta_str = f"Query: {query_text}" if query_text else "Generated Query"
            else:
                # Do not stringify the entire metadata dict, as it contains JSON characters
                # that crash the BM25 PyTerrier parser and pollute the semantic embedding.
                title = metadata.get("title", metadata.get("name", "Unknown Document"))
                meta_str = f"Title: {title}"
            
            # Sanitize to prevent prompt injection payload from breaking structure
            safe_meta_str = _sanitize_context(meta_str)
            context_parts.append(f"[{source_type}] {safe_meta_str}")
        
        # Sanitize queries as well
        safe_queries = [_sanitize_context(q) for q in queries]
        context_parts.extend(safe_queries)
        
        rich_context_text = " | ".join(context_parts)
        
        context_embedding = None
        
        try:
            embedding_url = settings.embedding_service.service_url
            embedding_timeout = getattr(settings.http_client, 'embedding_timeout', 30.0)
            async with httpx.AsyncClient(timeout=embedding_timeout) as client:
                embed_response = await client.post(
                    embedding_url,
                    json={
                        "input": [rich_context_text],
                        "model": settings.embedding_service.model,
                    }
                )
                embed_response.raise_for_status()
                embed_data = embed_response.json()
                context_embedding = embed_data["data"][0]["embedding"]
        except Exception as e:
            logger.warning("Failed to generate context embedding: %s. ICL search will be limited.", e)
        
        from data.database.repositories.proactive_agent import ProactiveAgentRepository
        
        embedding_model_name = settings.embedding_service.model
        proactive_repo = ProactiveAgentRepository(gateway)
        icl_examples = []
        
        try:
            from services.agents.proactive_icl_manager import get_proactive_icl_manager
            
            icl_manager = get_proactive_icl_manager()
            index_ready = await icl_manager.ensure_index(proactive_repo)
            
            if index_ready:
                icl_results = await asyncio.to_thread(
                    icl_manager.search,
                    query=rich_context_text,
                    top_k=10,
                    mode="hybrid",
                )
                
                if icl_results:
                    ranked = icl_manager.rank_with_composite(
                        icl_results, datetime.now(timezone.utc)
                    )
                    
                    for r in ranked[:5]:
                        meta = r.get("metadata", {})
                        rec_text = r.get("text", "").split(" | ")[0]
                        if rec_text:
                            icl_examples.append({
                                "recommendation": rec_text,
                                "userFeedback": meta.get("feedback") or "unknown",
                                "similarity": r.get("composite_score", 0.0),
                                "daysAgo": meta.get("days_ago", 0),
                            })
            else:
                logger.info("ICL index not ready (cold start) — trying pgvector fallback")
        except Exception as e:
            logger.warning("Aether-RAG ICL search failed: %s. Falling back to pgvector.", e)
        
        if not icl_examples and context_embedding is not None:
            try:
                similar_runs = await proactive_repo.search_similar_runs(
                    query_embedding=context_embedding,
                    similarity_threshold=0.7,
                    require_positive_feedback=False,
                    limit=5,
                    embedding_model=embedding_model_name,
                )
                
                for run in similar_runs:
                    recommendation = run.get("recommendation", "")
                    if recommendation:
                        icl_examples.append({
                            "recommendation": recommendation,
                            "userFeedback": run.get("user_feedback") or "unknown",
                            "similarity": run.get("similarity_score", 0.0),
                            "daysAgo": 0,
                        })
            except Exception as e:
                logger.warning("pgvector ICL fallback failed: %s", e)
        
        # ====================================================================================
        # Call Perplexica proactive agent with ICL examples
        # ====================================================================================
        agent_output = await call_perplexica_proactive_agent(
            queries=queries,
            source_docs=source_docs,
            settings=settings,
            icl_examples=icl_examples,
            trace_id=effective_trace_id,
            max_processing_time_seconds=max_processing_time_seconds,
        )
        
        end_time = asyncio.get_running_loop().time()
        execution_time_ms = int((end_time - start_time) * 1000)

        tool_budget = int(agent_output.get("toolBudget", 0) or 0)
        normalized_tool_budget = max(0, min(tool_budget, 4))
        agent_mode = f"budget_{normalized_tool_budget}"
        
        # Protect database from payload bloat (Phase 3 -> Phase 4 handoff)
        def _truncate_recursive(val: Any, max_len: int = 5000) -> Any:
            if isinstance(val, str):
                return val[:max_len] + "... [truncated]" if len(val) > max_len else val
            elif isinstance(val, (list, tuple)):
                # Hard cap arrays/tuples at 100 items to prevent row overflow
                truncated_items = [_truncate_recursive(item, max_len) for item in val[:100]]
                return type(val)(truncated_items)
            elif isinstance(val, dict):
                # Iterate all dict keys safely, applying truncation strictly to the strings and arrays within them
                return {k: _truncate_recursive(v, max_len) for k, v in val.items()}
            return val

        safe_queries = _truncate_recursive(queries, 1000)
        safe_source_docs = _truncate_recursive(source_docs)
        safe_context = _truncate_recursive(agent_output.get("context", []))
        safe_supporting = _truncate_recursive(agent_output.get("supportingDocs", []))
        safe_reasoning = _truncate_recursive(agent_output.get("reasoning", []), 2000)
        safe_defer_reason = _truncate_recursive(agent_output.get("deferReason"), 2000)
        
        run = await proactive_repo.insert_agent_run(
                query_ids=query_ids[:50],
                queries=safe_queries,
                source_docs=safe_source_docs,
                day_date=day_date,
                decision=agent_output["decision"],
                agent_mode=agent_mode,
                llm_model=agent_output.get("llm_model"),
                tool_calls_count=agent_output.get("tool_calls_count", 0),
                execution_time_ms=execution_time_ms,
                context_gathered=safe_context,
                recommendation=agent_output.get("recommendation"),
                supporting_docs=safe_supporting,
                reasoning_traces=safe_reasoning,
                session_id=session_id,
                context_embedding=context_embedding,
                embedding_model=embedding_model_name if context_embedding else None,
                defer_reason=safe_defer_reason,
                executed_tools=agent_output.get("executedTools", []),
            )
        
        logger.info("Proactive run stored: %s, decision: %s", run['id'], agent_output['decision'])
        
        return {
            "run_id": run["id"],
            "decision": agent_output["decision"],
            "recommendation": agent_output.get("recommendation"),
            "supporting_docs": agent_output.get("supportingDocs"),
            "context": run.get("context_gathered"),
            "tool_budget": normalized_tool_budget,
            "tool_calls_count": agent_output.get("tool_calls_count", 0),
            "executed_tools": agent_output.get("executedTools", []),
            "execution_time_ms": execution_time_ms,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "trace_id": effective_trace_id,
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Proactive scout execution failed [trace_id=%s]: %s", effective_trace_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "Proactive scout execution error",
                "trace_id": effective_trace_id,
            },
        )
