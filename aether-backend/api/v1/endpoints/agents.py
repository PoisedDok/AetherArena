"""
Agent Management Endpoints

API for configuring and orchestrating AI agents.

@.architecture
Incoming: HTTP clients, Agents Modal UI --- {http_request, json, agent_name}
Processing: validate payloads, orchestrate AgentService, manage configs --- {JOB_QUERY_DB, JOB_UPDATE_CONFIG, JOB_QUEUE_JOB}
Outgoing: application/agents/agent_service.py, FastAPI responses --- {Dict[str, Any], json}
"""

from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from uuid import UUID
from datetime import datetime, timezone

from core.exceptions import DomainException
from api.dependencies import setup_request_context, get_supabase_uow
from data.network.llm_gateway import get_llm_gateway
from api.v1.schemas.agent import (
    AgentConfigResponse,
    AgentConfigUpdate,
    AgentJobCreate,
    AgentJobResponse,
    JobActionResponse,
    AgentOutputResponse,
    AgentStatusResponse
)
from application.agents.agent_service import AgentService
from data.database.uow import SupabaseUnitOfWork
from config.settings import get_settings
from services.agents.prompt_loader import get_prompt_loader
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["agents"], prefix="/agents")
# Action-style endpoints (nested context friendly)
action_router = APIRouter(tags=["agent-actions"], prefix="/agent")


# =============================================================================
# Dependencies
# =============================================================================

async def get_agent_service(
    uow: SupabaseUnitOfWork = Depends(get_supabase_uow)
) -> AgentService:
    """Dependency to get AgentService instance."""
    return AgentService(uow)


def _parse_job_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.min
    return datetime.min


def _append_error_message(existing: Optional[str], addition: str) -> str:
    if not addition:
        return existing or ""
    if not existing:
        return addition
    return f"{existing} | {addition}"


# =============================================================================
# Agent Configuration Endpoints
# =============================================================================

async def _list_agent_configs(
    agent_service: AgentService,
) -> List[AgentConfigResponse]:
    """
    Helper: list all agent configurations.
    """
    try:
        configs = await agent_service.list_agent_configs()
        return [AgentConfigResponse(**config) for config in configs]
    except Exception as e:
        logger.error("Failed to list agent configs: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list agent configs. Check server logs for details."
        )


@action_router.get("/configs", response_model=List[AgentConfigResponse], summary="List agent configurations")
async def agent_configs(
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> List[AgentConfigResponse]:
    """
    List agent configurations (action_source).
    Clean endpoint: /v1/agent/configs
    """
    return await _list_agent_configs(agent_service)


async def _create_agent_config(
    config: AgentConfigUpdate,
    agent_service: AgentService,
) -> AgentConfigResponse:
    """
    Helper: create a new agent configuration.
    """
    try:
        created_config = await agent_service.create_agent_config(config.dict(exclude_unset=True))
        return AgentConfigResponse(**created_config)
    except ValueError as e:
        logger.warning("Invalid agent configuration: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid agent configuration. Check server logs for details."
        )
    except Exception as e:
        logger.error("Failed to create agent config: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create agent config. Check server logs for details."
        )


@action_router.post("/config", response_model=AgentConfigResponse, summary="Create agent configuration", status_code=status.HTTP_201_CREATED)
async def agent_create_config(
    config: AgentConfigUpdate,
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> AgentConfigResponse:
    """
    Create agent configuration (action_source).
    Clean endpoint: /v1/agent/config
    """
    return await _create_agent_config(config, agent_service)


async def _get_agent_config(
    agent_name: str,
    agent_service: AgentService,
) -> AgentConfigResponse:
    """
    Helper: get specific agent configuration by name.
    """
    try:
        config = await agent_service.get_agent_config(agent_name)
        if not config:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Agent configuration not found: {agent_name}"
            )
        return AgentConfigResponse(**config)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get agent config %s: %s", agent_name, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get agent config. Check server logs for details."
        )


@action_router.get("/config/{agent_name}", response_model=AgentConfigResponse, summary="Get agent configuration")
async def agent_get_config(
    agent_name: str,
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> AgentConfigResponse:
    """
    Get agent configuration (action_source).
    Clean endpoint: /v1/agent/config/{agent_name}
    """
    return await _get_agent_config(agent_name, agent_service)


async def _update_agent_config(
    agent_name: str,
    request: AgentConfigUpdate,
    agent_service: AgentService,
) -> AgentConfigResponse:
    """
    Helper: update agent configuration.
    """
    try:
        # Only include non-None fields
        updates = request.dict(exclude_none=True)

        if not updates:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No updates provided"
            )

        updated_config = await agent_service.update_agent_config(agent_name, updates)
        return AgentConfigResponse(**updated_config)
    except ValueError as e:
        logger.warning("Agent config not found: %s", e)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent configuration not found."
        )
    except Exception as e:
        logger.error("Failed to update agent config %s: %s", agent_name, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update agent config. Check server logs for details."
        )


@action_router.put("/config/{agent_name}", response_model=AgentConfigResponse, summary="Update agent configuration")
async def agent_update_config(
    agent_name: str,
    request: AgentConfigUpdate,
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> AgentConfigResponse:
    """
    Update agent configuration (action_source).
    Clean endpoint: /v1/agent/config/{agent_name}
    """
    return await _update_agent_config(agent_name, request, agent_service)


async def _delete_agent_config(
    agent_name: str,
    agent_service: AgentService,
) -> None:
    """
    Helper: delete an agent configuration.
    """
    try:
        await agent_service.delete_agent_config(agent_name)
        return None
    except ValueError as e:
        logger.warning("Agent config not found for deletion: %s", e)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent configuration not found."
        )
    except Exception as e:
        logger.error("Failed to delete agent config %s: %s", agent_name, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete agent config. Check server logs for details."
        )


@action_router.delete("/config/{agent_name}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete agent configuration")
async def agent_delete_config(
    agent_name: str,
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
):
    """
    Delete agent configuration (action_source).
    Clean endpoint: /v1/agent/config/{agent_name}
    """
    return await _delete_agent_config(agent_name, agent_service)


# =============================================================================
# Agent Metadata Endpoints (Models, Templates)
# =============================================================================

async def _list_agent_models(gateway) -> Dict[str, Any]:
    """
    Helper: get list of available LLM models for agent configuration.
    """
    try:
        from core.exceptions import UpstreamServiceError, NetworkTimeoutError, NetworkConnectionError
        settings = get_settings()

        models = []

        # Fetch models from LLM provider (LM Studio or configured endpoint)
        llm_api_base = settings.llm.api_base

        try:
            llm_models_data = await gateway.fetch_models(f"{llm_api_base}/models", {}, timeout=5.0)

            # Parse OpenAI-compatible models response
            if "data" in llm_models_data:
                for model_info in llm_models_data["data"]:
                    model_id = model_info.get("id", "")

                    # Skip embedding models for agent configuration
                    if "embedding" in model_id.lower():
                        continue

                    category = "unknown"

                    models.append({
                        "name": model_id,
                        "provider": model_info.get("owned_by", "unknown"),
                        "category": category,
                        "recommended_for": [],
                        "description": f"Available via {llm_api_base}"
                    })

            logger.info("Fetched %d models from %s", len(models), llm_api_base)
        except (UpstreamServiceError, NetworkTimeoutError, NetworkConnectionError) as e:
            logger.warning("Failed to fetch models from %s: %s", llm_api_base, e)
            # Fallback: Use currently configured model
            if hasattr(settings.llm, 'model'):
                models.append({
                    "name": settings.llm.model,
                    "provider": "configured",
                    "category": "unknown",
                    "recommended_for": [],
                    "description": "Currently configured model"
                })

        # Always add "custom" option for user-defined endpoints
        models.append({
            "name": "custom",
            "provider": "user_defined",
            "category": "custom",
            "recommended_for": [],
            "description": "Custom model endpoint (user configurable)"
        })

        return {
            "models": models,
            "total": len(models),
            "source": llm_api_base
        }
    except Exception as e:
        logger.error("Failed to get available models: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get available models. Check server logs for details."
        )


@action_router.get("/models", summary="List agent models")
async def agent_models(
    _context: dict = Depends(setup_request_context),
    gateway = Depends(get_llm_gateway)
) -> Dict[str, Any]:
    """
    List agent models (action_source).
    Clean endpoint: /v1/agent/models
    """
    return await _list_agent_models(gateway)


async def _list_agent_templates() -> Dict[str, Any]:
    """
    Helper: get pre-defined agent templates for quick setup.
    """
    try:
        settings = get_settings()
        loader = get_prompt_loader()
        agent_types = loader.list_available_agents()
        templates = []

        for agent_type in sorted(agent_types):
            prompt_data = loader.load_prompt(agent_type)
            default_config = dict(prompt_data.get("default_config", {}))

            display_name = prompt_data.get(
                "display_name",
                agent_type.replace("_", " ").title()
            )
            description = prompt_data.get("description", "")
            execution_trigger = default_config.get("execution_trigger", "on_demand")
            trigger_frequency = default_config.get("trigger_frequency")

            prompt_template = prompt_data.get("prompt_template", "")
            preview_line = next(
                (line.strip() for line in prompt_template.splitlines() if line.strip()),
                ""
            )

            templates.append({
                "name": agent_type,
                "display_name": display_name,
                "description": description,
                "agent_type": agent_type,
                "default_model": settings.llm.model,
                "execution_trigger": execution_trigger,
                "trigger_frequency": trigger_frequency,
                "recommended_config": default_config,
                "variables": prompt_data.get("variables", []),
                "version": prompt_data.get("version"),
                "prompt_preview": preview_line[:140] if preview_line else ""
            })

        return {
            "templates": templates,
            "total": len(templates)
        }
    except Exception as e:
        logger.error("Failed to get agent templates: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get agent templates. Check server logs for details."
        )


@action_router.get("/templates", summary="List agent templates")
async def agent_templates(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    List agent templates (action_source).
    Clean endpoint: /v1/agent/templates
    """
    return await _list_agent_templates()


# =============================================================================
# Job Management Endpoints
# =============================================================================

@action_router.post("/start", response_model=AgentJobResponse, status_code=status.HTTP_201_CREATED, summary="Start agent job")
async def agent_start(
    request: AgentJobCreate,
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> AgentJobResponse:
    """
    Start an agent job (action_source).
    Clean endpoint: /v1/agent/start
    """
    try:
        job_id = await agent_service.queue_agent_job(
            agent_name=request.agent_name,
            entity_id=request.entity_id,
            entity_type=request.entity_type,
            priority=request.priority,
            metadata=request.metadata,
            execution_strategy=request.execution_strategy,
            depends_on=request.depends_on,
            batch_group=request.batch_group,
            resource_cost=request.resource_cost
        )

        return AgentJobResponse(
            job_id=job_id,
            agent_name=request.agent_name,
            entity_id=request.entity_id,
            entity_type=request.entity_type,
            status="pending",
            created_at=datetime.now(timezone.utc)
        )
    except ValueError as e:
        logger.warning("Invalid agent job request: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid agent job request. Check server logs for details."
        )
    except Exception as e:
        logger.error("Failed to create agent job: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create agent job. Check server logs for details."
        )


@action_router.get("/status/{job_id}", summary="Agent job status")
async def agent_status(
    job_id: UUID,
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Agent job status (action_source).
    Clean endpoint: /v1/agent/status/{job_id}
    """
    try:
        return await agent_service.get_agent_job_status(job_id)
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e))
    except Exception as e:
        logger.error("Failed to get status %s: %s", job_id, e, exc_info=True)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to get status. Check server logs.")


@action_router.get("/jobs", summary="Agent jobs")
async def agent_jobs(
    agent_name: Optional[str] = Query(None, description="Filter by agent name"),
    status_filter: Optional[str] = Query(None, description="Filter by job status"),
    on_demand_only: bool = Query(False, description="If true, only return on-demand agent jobs (tool jobs)"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum jobs to return"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Agent jobs listing (action_source).
    Clean endpoint: /v1/agent/jobs
    """
    try:
        return await agent_service.list_agent_jobs(
            agent_name=agent_name,
            status_filter=status_filter,
            on_demand_only=on_demand_only,
            limit=limit,
            offset=offset
        )
    except Exception:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to list jobs. Check server logs.")


@action_router.get("/history", summary="Unified job and output history")
async def agent_history(
    agent_name: Optional[str] = Query(None, description="Filter by agent name"),
    limit: int = Query(50, ge=1, le=200, description="Maximum items to return"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Unified history endpoint combining pending_jobs AND agent_outputs.
    Returns combined, sorted list for Jobs Modal.
    Clean endpoint: /v1/agent/history
    """
    try:
        fetch_limit = limit + offset
        jobs_response = await agent_service.list_agent_jobs(
            agent_name=agent_name,
            status_filter=None,
            on_demand_only=True,
            limit=fetch_limit,
            offset=0
        )
        
        outputs = await agent_service.get_agent_outputs(
            agent_name=agent_name,
            output_type=None,
            entity_id=None,
            limit=fetch_limit,
            offset=0
        )
        
        history = []
        
        for job in jobs_response.get('jobs', []):
            history.append({
                "type": "job",
                "id": str(job.get('id') or job.get('job_id')),
                "agent_name": job.get('agent_name'),
                "status": job.get('status'),
                "created_at": job.get('created_at'),
                "completed_at": job.get('completed_at'),
                "entity_type": job.get('entity_type'),
                "metadata": job.get('metadata'),
                "job_type": job.get('job_type')
            })
        
        for output in outputs:
            out_type = output.get('output_type')
            agent = output.get('agent_name')

            content = output.get('content', {})
            history.append({
                "type": "output",
                "id": str(output.get('id')),
                "agent_name": output.get('agent_name'),
                "output_type": out_type,
                "status": "completed",
                "created_at": output.get('created_at'),
                "completed_at": output.get('created_at'),
                "entity_id": output.get('entity_id'),
                "content": content,
                "query": content.get('query') or content.get('filename') or content.get('title'),
                "time_ms": content.get('time_ms'),
                "sources": content.get('sources', [])
            })
        
        history.sort(key=lambda x: x.get('created_at') or '', reverse=True)
        paginated = history[offset:offset + limit]
        
        return {
            "history": paginated,
            "total": len(history),
            "limit": limit,
            "offset": offset
        }
        
    except Exception as e:
        logger.error("Failed to get agent history: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get agent history. Check server logs for details."
        )


@action_router.post("/stop/{job_id}", response_model=JobActionResponse, summary="Stop agent job")
async def agent_stop(
    job_id: UUID,
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> JobActionResponse:
    """
    Stop an agent job (action_source).
    Clean endpoint: /v1/agent/stop/{job_id}
    """
    try:
        updated = await agent_service.cancel_job(job_id)
        return JobActionResponse(
            job_id=job_id,
            status=updated.get("status", "cancelled") if isinstance(updated, dict) else "cancelled",
            message="Job cancelled",
            job=updated if isinstance(updated, dict) else {}
        )
    except ValueError as e:
        error_msg = str(e)
        if "not found" in error_msg.lower():
            raise HTTPException(status.HTTP_404_NOT_FOUND, error_msg)
        raise HTTPException(status.HTTP_409_CONFLICT, error_msg)
    except Exception:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to stop job.")


@action_router.post("/retry/{job_id}", response_model=JobActionResponse, summary="Retry agent job")
async def agent_retry(
    job_id: UUID,
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> JobActionResponse:
    """
    Retry an agent job (action_source).
    Clean endpoint: /v1/agent/retry/{job_id}
    """
    try:
        updated = await agent_service.retry_job(job_id)
        return JobActionResponse(
            job_id=job_id,
            status=updated.get("status", "pending") if isinstance(updated, dict) else "pending",
            message="Job reset to pending",
            job=updated if isinstance(updated, dict) else {}
        )
    except ValueError as e:
        error_msg = str(e)
        if "not found" in error_msg.lower():
            raise HTTPException(status.HTTP_404_NOT_FOUND, error_msg)
        raise HTTPException(status.HTTP_409_CONFLICT, error_msg)
    except Exception:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to retry job.")


@action_router.delete("/delete/{job_id}", response_model=JobActionResponse, summary="Delete agent job")
async def agent_delete(
    job_id: UUID,
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> JobActionResponse:
    """
    Delete an agent job (action_source).
    Clean endpoint: /v1/agent/delete/{job_id}
    """
    try:
        await agent_service.delete_job_or_output(job_id)
        return JobActionResponse(
            job_id=job_id,
            status="deleted",
            message="Record deleted"
        )
    except ValueError as e:
        error_msg = str(e)
        if "not found" in error_msg.lower():
            raise HTTPException(status.HTTP_404_NOT_FOUND, error_msg)
        raise HTTPException(status.HTTP_409_CONFLICT, error_msg)
    except Exception:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to delete job.")


# =============================================================================
# Agent Output Endpoints
# =============================================================================

@action_router.get("/outputs", response_model=List[AgentOutputResponse], summary="List agent outputs")
async def agent_outputs(
    agent_name: str = Query(..., description="Agent name"),
    output_type: Optional[str] = Query(None, description="Filter by output type"),
    entity_id: Optional[UUID] = Query(None, description="Filter by entity ID"),
    limit: int = Query(50, ge=1, le=100, description="Maximum results"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> List[AgentOutputResponse]:
    """
    List agent outputs (action_source).
    Clean endpoint: /v1/agent/outputs?agent_name=...
    """
    try:
        outputs = await agent_service.get_agent_outputs(
            agent_name=agent_name,
            output_type=output_type,
            entity_id=entity_id,
            limit=limit,
            offset=offset
        )
        return [AgentOutputResponse(**output) for output in outputs]
    except Exception as e:
        logger.error("Failed to get agent outputs: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get agent outputs. Check server logs for details."
        )


# =============================================================================
# Status Endpoints
# =============================================================================

@action_router.get("/status", response_model=AgentStatusResponse, summary="Agent system status")
async def agent_status_summary(
    agent_service: AgentService = Depends(get_agent_service),
    _context: dict = Depends(setup_request_context)
) -> AgentStatusResponse:
    """
    Agent system status (action_source).
    Clean endpoint: /v1/agent/status
    """
    try:
        return await agent_service.get_system_status_summary()
    except Exception:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Failed to get system status.")
