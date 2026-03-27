"""
Agent Service

Manages AI agent configurations and job orchestration.

@.architecture
Incoming: API endpoints, Worker handlers --- {agent_name, config updates, job requests}
Processing: agent config CRUD, job queueing --- {4 jobs: JOB_QUERY_DB, JOB_MANAGE_STORAGE, JOB_VALIDATE, JOB_QUEUE_JOB}
Outgoing: Database (agent_configs, agent_outputs, pending_jobs) --- {config, jobs, outputs}
"""

from typing import List, Dict, Any, Optional
from uuid import UUID
from datetime import datetime, timezone

from data.database.uow import SupabaseUnitOfWork
from config.settings import get_settings
from monitoring import get_logger

logger = get_logger(__name__)

class AgentService:
    """
    Service for managing AI agent configurations and orchestration.
    
    Features:
    - Agent configuration CRUD (NO HARDCODING - all from DB)
    - Job queue management for agent processing
    - Agent output storage and retrieval
    - Integration with AetherRag indexes
    
    Design Principles:
    - ALL settings user-configurable via Agents Modal
    - Agents disabled by default
    - No hardcoded models, prompts, or triggers
    """
    
    def __init__(self, uow: SupabaseUnitOfWork):
        self._uow = uow
        self._gateway = uow.gateway
    
    async def list_agent_configs(self) -> List[Dict[str, Any]]:
        try:
            configs = await self._gateway.select(
                "agent_configs",
                order_by="agent_name"
            )
            
            TOOL_AGENTS = {"research"}
            for config in configs:
                agent_name = config.get("agent_name")
                is_tool_agent = agent_name in TOOL_AGENTS or config.get("execution_trigger") == "on_demand"
                if is_tool_agent:
                    config["enabled"] = True
                    
            logger.debug("Retrieved %d agent configurations (tool agents forced to enabled)", len(configs))
            return configs
        except Exception as e:
            logger.error("Failed to list agent configs: %s", e, exc_info=True)
            raise
    
    async def get_agent_config(self, agent_name: str) -> Optional[Dict[str, Any]]:
        try:
            configs = await self._gateway.select(
                "agent_configs",
                filters={"agent_name": agent_name},
                limit=1
            )
            
            if not configs:
                logger.warning("Agent config not found: %s", agent_name)
                return None
            
            logger.info("Retrieved config for agent: %s", agent_name)
            return configs[0]
        except Exception as e:
            logger.error("Failed to get agent config %s: %s", agent_name, e, exc_info=True)
            raise
    
    async def create_agent_config(
        self,
        config_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        try:
            required_fields = ['agent_name', 'agent_type', 'model_name', 'prompt_template', 'execution_trigger']
            missing = [f for f in required_fields if f not in config_data]
            if missing:
                raise ValueError(f"Missing required fields: {', '.join(missing)}")
            
            existing = await self.get_agent_config(config_data['agent_name'])
            if existing:
                raise ValueError(f"Agent already exists: {config_data['agent_name']}")
            
            if 'enabled' not in config_data:
                config_data['enabled'] = False
            if 'configuration' not in config_data:
                config_data['configuration'] = {}
            
            result = await self._gateway.insert("agent_configs", config_data)
            config_record = result[0] if isinstance(result, list) else result
            
            logger.info("Created new agent config: %s", config_data["agent_name"], extra={
                "agent_name": config_data["agent_name"],
                "agent_type": config_data["agent_type"],
            })
            
            return config_record
        except Exception as e:
            logger.error("Failed to create agent config: %s", e, exc_info=True)
            raise
    
    async def update_agent_config(
        self,
        agent_name: str,
        updates: Dict[str, Any]
    ) -> Dict[str, Any]:
        try:
            current = await self.get_agent_config(agent_name)
            if not current:
                raise ValueError(f"Agent config not found: {agent_name}")
            
            updated = await self._gateway.update(
                "agent_configs",
                updates,
                record_id=current['id']
            )
            
            if isinstance(updated, list) and updated:
                updated = updated[0]
            
            logger.info("Updated agent config: %s", agent_name, extra={
                "agent_name": agent_name,
                "updated_fields": list(updates.keys()),
            })
            
            return updated
        except Exception as e:
            logger.error("Failed to update agent config %s: %s", agent_name, e, exc_info=True)
            raise
    
    async def delete_agent_config(self, agent_name: str) -> None:
        try:
            current = await self.get_agent_config(agent_name)
            if not current:
                raise ValueError(f"Agent config not found: {agent_name}")
            
            await self._gateway.delete("agent_configs", record_id=current['id'])
            
            logger.info("Deleted agent config: %s", agent_name, extra={
                "agent_name": agent_name,
                "agent_id": current["id"],
            })
        except Exception as e:
            logger.error("Failed to delete agent config %s: %s", agent_name, e, exc_info=True)
            raise
    
    async def queue_agent_job(
        self,
        agent_name: str,
        entity_id: UUID,
        entity_type: str,
        priority: int = 5,
        metadata: Optional[Dict[str, Any]] = None,
        execution_strategy: str = "parallel",
        depends_on: Optional[UUID] = None,
        batch_group: Optional[str] = None,
        resource_cost: Optional[int] = None,
        job_type_override: Optional[str] = None,
        status: str = "pending"
    ) -> UUID:
        try:
            agent_config = await self.get_agent_config(agent_name)
            if not agent_config:
                raise ValueError(f"Agent not found: {agent_name}")
            
            TOOL_AGENTS = {"research"}
            is_tool_agent = agent_name in TOOL_AGENTS or agent_config.get("execution_trigger") == "on_demand"
            
            if not is_tool_agent and not agent_config['enabled']:
                raise ValueError(f"Agent is disabled: {agent_name}")
            
            job_type_map = {
                "memory": "extract_memories",
                "research": "agent_research"
            }
            allowed_job_types = set(job_type_map.values())
            
            if job_type_override:
                if job_type_override not in allowed_job_types:
                    raise ValueError(
                        f"Unsupported job_type_override '{job_type_override}'. "
                        f"Allowed: {sorted(allowed_job_types)}"
                    )
                job_type = job_type_override
            else:
                job_type = job_type_map.get(agent_name)
            
            if not job_type:
                raise ValueError(
                    f"Agent '{agent_name}' is not queueable via jobs API. "
                    f"Available tool-job agents: research, memory."
                )
            
            settings = get_settings()
            queue_settings = settings.workers.job_queue
            resource_cost_map = {
                "summarize_chat": queue_settings.resource_cost_summarize,
                "extract_memories": queue_settings.resource_cost_extract_memories,
                "promote_memories": queue_settings.resource_cost_promote_memories,
                "agent_research": queue_settings.resource_cost_research
            }
            
            if resource_cost is None:
                resource_cost = resource_cost_map.get(job_type, queue_settings.resource_cost_default)
            
            job_data = {
                "job_type": job_type,
                "agent_name": agent_name,
                "entity_id": str(entity_id),
                "entity_type": entity_type,
                "priority": priority,
                "metadata": metadata or {},
                "execution_strategy": execution_strategy,
                "depends_on": str(depends_on) if depends_on else None,
                "batch_group": batch_group,
                "resource_cost": resource_cost,
                "status": status
            }
            
            result = await self._gateway.insert("pending_jobs", job_data)
            job_record = result[0] if isinstance(result, list) else result
            job_id = UUID(job_record['id'])
            
            logger.info("Queued job for agent %s (status=%s)", agent_name, status, extra={
                "job_id": str(job_id),
                "agent_name": agent_name,
                "entity_id": str(entity_id),
                "entity_type": entity_type,
            })
            
            return job_id
        except Exception as e:
            logger.error("Failed to queue job for agent %s: %s", agent_name, e, exc_info=True)
            raise
            
    async def get_job(self, job_id: UUID) -> Dict[str, Any]:
        """Get a specific job record."""
        try:
            jobs = await self._gateway.select(
                "pending_jobs",
                filters={"id": str(job_id)},
                limit=1
            )
            if not jobs:
                raise ValueError(f"Job not found: {job_id}")
            return jobs[0]
        except Exception as e:
            logger.error("Failed to get job %s: %s", job_id, e, exc_info=True)
            raise

    async def get_agent_outputs(
        self,
        agent_name: Optional[str] = None,
        output_type: Optional[str] = None,
        entity_id: Optional[UUID] = None,
        limit: int = 50,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        try:
            filters = {}
            if agent_name:
                filters["agent_name"] = agent_name
            if output_type:
                filters["output_type"] = output_type
            if entity_id:
                filters["entity_id"] = str(entity_id)
            
            outputs = await self._gateway.select(
                "agent_outputs",
                filters=filters,
                limit=limit,
                offset=offset,
                order_by="created_at.desc"
            )
            
            logger.info("Retrieved %d agent outputs", len(outputs), extra={
                "agent_name": agent_name,
                "output_type": output_type,
                "limit": limit,
            })
            
            return outputs
        except Exception as e:
            logger.error("Failed to get agent outputs: %s", e, exc_info=True)
            raise
    
    async def store_agent_output(
        self,
        agent_name: str,
        output_type: str,
        content: Dict[str, Any],
        job_id: Optional[UUID] = None,
        entity_id: Optional[UUID] = None,
        aether_rag_index_name: Optional[str] = None
    ) -> UUID:
        try:
            output_data = {
                "agent_name": agent_name,
                "output_type": output_type,
                "content": content,
                "job_id": str(job_id) if job_id else None,
                "entity_id": str(entity_id) if entity_id else None,
                "aether_rag_index_name": aether_rag_index_name
            }
            
            result = await self._gateway.insert("agent_outputs", output_data)
            output_record = result[0] if isinstance(result, list) else result
            output_id = UUID(output_record['id'])
            
            logger.info("Stored output from agent %s", agent_name, extra={
                "output_id": str(output_id),
                "agent_name": agent_name,
                "output_type": output_type,
                "aether_rag_index": aether_rag_index_name,
            })
            
            return output_id
        except Exception as e:
            logger.error("Failed to store agent output: %s", e, exc_info=True)
            raise
    
    async def get_enabled_agents(self) -> List[Dict[str, Any]]:
        try:
            enabled_agents = await self._gateway.select(
                "agent_configs",
                filters={"enabled": True},
                order_by="agent_name"
            )
            
            logger.info("Retrieved %d enabled agents", len(enabled_agents))
            return enabled_agents
        except Exception as e:
            logger.error("Failed to get enabled agents: %s", e, exc_info=True)
            raise

    # -------------------------------------------------------------------------
    # Job Orchestration methods migrated from Presentation layer
    # -------------------------------------------------------------------------
    
    def _parse_job_timestamp(self, value: Any) -> datetime:
        if isinstance(value, datetime):
            return value
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return datetime.min
        return datetime.min

    async def _build_queue_positions(self) -> Dict[str, int]:
        try:
            pending_jobs = await self._gateway.select(
                "pending_jobs",
                filters={"status": "pending"},
                order_by="created_at.asc",
                limit=1000
            )
            ordered = sorted(
                pending_jobs,
                key=lambda job: (-int(job.get("priority", 0)), self._parse_job_timestamp(job.get("created_at")))
            )
            return {job["id"]: index + 1 for index, job in enumerate(ordered)}
        except Exception as e:
            logger.error("Failed to build queue positions: %s", e, exc_info=True)
            return {}

    def _append_error_message(self, existing: Optional[str], addition: str) -> str:
        if not addition:
            return existing or ""
        if not existing:
            return addition
        return f"{existing} | {addition}"

    async def get_agent_job_status(self, job_id: UUID) -> Dict[str, Any]:
        """Get status of a specific job or completed output."""
        try:
            # 1. Try pending_jobs table first (active jobs)
            jobs = await self._gateway.select(
                "pending_jobs",
                filters={"id": str(job_id)},
                limit=1
            )

            if jobs:
                return jobs[0]
                
            # 2. Try agent_outputs table (completed history)
            outputs = await self._gateway.select(
                "agent_outputs",
                filters={"id": str(job_id)},
                limit=1
            )
            
            if outputs:
                output = outputs[0]
                return {
                    "type": "output",
                    "id": str(output.get('id')),
                    "job_id": str(output.get('id')),
                    "agent_name": output.get('agent_name'),
                    "output_type": output.get('output_type'),
                    "status": "completed",
                    "created_at": output.get('created_at'),
                    "completed_at": output.get('created_at'),
                    "entity_id": output.get('entity_id'),
                    "content": output.get('content', {}),
                    "metadata": output.get('content', {}),
                    "query": output.get('content', {}).get('query'),
                    "time_ms": output.get('content', {}).get('time_ms')
                }

            raise ValueError(f"Record not found: {job_id}")
        except Exception as e:
            logger.error("Failed to get agent job status %s: %s", job_id, e, exc_info=True)
            raise

    async def list_agent_jobs(
        self,
        agent_name: Optional[str],
        status_filter: Optional[str],
        on_demand_only: bool,
        limit: int,
        offset: int
    ) -> Dict[str, Any]:
        """List jobs from pending_jobs with optional filtering."""
        try:
            filters = {}
            in_filters = {}

            if agent_name:
                filters["agent_name"] = agent_name
            if status_filter:
                filters["status"] = status_filter
            
            configs = await self.list_agent_configs()
            TOOL_AGENT_NAMES = {"research"}
            
            on_demand_agents = {
                config.get("agent_name")
                for config in configs
                if config.get("execution_trigger") == "on_demand" or config.get("agent_name") in TOOL_AGENT_NAMES
            }

            if on_demand_only:
                filters["entity_type"] = {"neq": "system"}
                if agent_name:
                    if agent_name not in on_demand_agents:
                        return {"jobs": [], "total": 0, "limit": limit, "offset": offset, "queue": {"pending_count": 0}}
                else:
                    in_filters["agent_name"] = list(on_demand_agents)

            jobs = await self._gateway.select(
                "pending_jobs",
                filters=filters or None,
                in_filters=in_filters or None,
                order_by="created_at.desc",
                limit=limit,
                offset=offset
            )

            if on_demand_only:
                def _get_metadata(job: Dict[str, Any]) -> Dict[str, Any]:
                    meta = job.get("metadata")
                    if isinstance(meta, dict):
                        return meta
                    if isinstance(meta, str):
                        try:
                            import json as _json
                            parsed = _json.loads(meta)
                            return parsed if isinstance(parsed, dict) else {}
                        except Exception:
                            return {}
                    return {}

                def _resolve_job_agent(job: Dict[str, Any]) -> Optional[str]:
                    name = job.get("agent_name")
                    if name:
                        return name
                    job_type = str(job.get("job_type") or "")
                    if job_type.startswith("agent_"):
                        suffix = job_type[len("agent_"):]
                        return suffix.split("_")[0] if suffix else None
                    return None

                filtered: List[Dict[str, Any]] = []
                for job in jobs:
                    if job.get("entity_type") == "system":
                        continue
                    meta = _get_metadata(job)
                    trigger = str(meta.get("trigger") or "")
                    if trigger.startswith("cron"):
                        continue
                    
                    agent_for_job = _resolve_job_agent(job)
                    if not agent_for_job or agent_for_job not in on_demand_agents:
                        continue
                    filtered.append(job)
                jobs = filtered

            queue_positions: Dict[str, int] = {}
            if any(job.get("status") == "pending" for job in jobs):
                queue_positions = await self._build_queue_positions()
                for job in jobs:
                    if job.get("status") == "pending":
                        job["queue_position"] = queue_positions.get(job.get("id"))
            
            return {
                "jobs": jobs,
                "total": len(jobs),
                "limit": limit,
                "offset": offset,
                "queue": {
                    "pending_count": sum(1 for job in jobs if job.get("status") == "pending")
                }
            }
        except Exception as e:
            logger.error("Failed to list agent jobs: %s", e, exc_info=True)
            raise

    async def cancel_job(self, job_id: UUID) -> Dict[str, Any]:
        """Cancel a pending job."""
        try:
            job = await self.get_job(job_id)
            status_value = job.get("status")
            if status_value != "pending":
                raise ValueError(f"Job {job_id} cannot be cancelled from status '{status_value}'")
            
            updates = {
                "status": "cancelled",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "error_message": self._append_error_message(job.get("error_message"), "cancelled by user")
            }
            updated = await self._gateway.update("pending_jobs", updates, record_id=str(job_id))
            
            if isinstance(updated, list) and updated:
                updated = updated[0]
                
            logger.info("Cancelled job %s", job_id, extra={"job_id": str(job_id)})
            return updated if isinstance(updated, dict) else {}
        except Exception as e:
            logger.error("Failed to cancel job %s: %s", job_id, e, exc_info=True)
            raise

    async def retry_job(self, job_id: UUID) -> Dict[str, Any]:
        """Retry a failed job by resetting it to pending."""
        try:
            job = await self.get_job(job_id)
            status_value = job.get("status")
            if status_value != "failed":
                raise ValueError(f"Job {job_id} cannot be retried from status '{status_value}'")
            
            retry_count = int(job.get("retry_count") or 0)
            max_retries = int(job.get("max_retries") or 0)
            if max_retries and retry_count >= max_retries:
                raise ValueError(f"Job {job_id} exceeded max retries")
                
            updates = {
                "status": "pending",
                "retry_count": retry_count + 1,
                "started_at": None,
                "completed_at": None,
                "error_message": self._append_error_message(job.get("error_message"), "manual retry")
            }
            updated = await self._gateway.update("pending_jobs", updates, record_id=str(job_id))
            
            if isinstance(updated, list) and updated:
                updated = updated[0]
                
            logger.info("Retried job %s", job_id, extra={"job_id": str(job_id)})
            return updated if isinstance(updated, dict) else {}
        except Exception as e:
            logger.error("Failed to retry job %s: %s", job_id, e, exc_info=True)
            raise

    async def delete_job_or_output(self, job_id: UUID) -> None:
        """Delete a completed/failed/cancelled job OR a historical output."""
        try:
            # 1. Try pending_jobs first
            jobs = await self._gateway.select(
                "pending_jobs",
                filters={"id": str(job_id)},
                limit=1
            )
            
            if jobs:
                job = jobs[0]
                status_value = job.get("status")
                if status_value not in {"completed", "failed", "cancelled"}:
                    raise ValueError(f"Job {job_id} cannot be deleted from status '{status_value}'")
                await self._gateway.delete("pending_jobs", record_id=str(job_id))
                logger.info("Deleted job %s from pending_jobs", job_id, extra={"job_id": str(job_id)})
                return

            # 2. Try agent_outputs (historical results)
            outputs = await self._gateway.select(
                "agent_outputs",
                filters={"id": str(job_id)},
                limit=1
            )
            
            if outputs:
                await self._gateway.delete("agent_outputs", record_id=str(job_id))
                logger.info("Deleted historical output %s from agent_outputs", job_id, extra={"job_id": str(job_id)})
                return

            raise ValueError(f"Record not found: {job_id}")
        except Exception as e:
            logger.error("Failed to delete record %s: %s", job_id, e, exc_info=True)
            raise

    async def get_system_status_summary(self) -> Dict[str, Any]:
        """Get overall agent system status."""
        try:
            all_configs = await self.list_agent_configs()
            enabled_agents = [c for c in all_configs if c['enabled']]

            pending_jobs = await self._gateway.select(
                "pending_jobs",
                filters={"status": "pending"},
                limit=1000
            )

            return {
                "total_agents": len(all_configs),
                "enabled_agents": len(enabled_agents),
                "pending_jobs": len(pending_jobs),
                "agents": [{
                    "name": c['agent_name'],
                    "type": c['agent_type'],
                    "enabled": c['enabled'],
                    "model": c['model_name']
                } for c in all_configs]
            }
        except Exception as e:
            logger.error("Failed to get agent status summary: %s", e, exc_info=True)
            raise

    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
