"""
@.architecture
Incoming: api/v1/endpoints/agents.py, application/agents/agent_service.py --- {Dict[str, Any], json}
Processing: Pydantic validation for agent configuration payloads --- {JOB_VALIDATE_SCHEMA}
Outgoing: api/v1/endpoints/agents.py --- {validated Pydantic model instances}

Agent Schemas - Pydantic models for agent configuration and orchestration.
"""

from typing import Optional, Dict, Any, Literal
from pydantic import BaseModel, Field, validator
from uuid import UUID
from datetime import datetime


class AgentConfigResponse(BaseModel):
    """Agent configuration response."""
    id: UUID
    agent_name: str
    agent_type: str
    enabled: bool
    model_name: str
    prompt_template: str
    execution_trigger: str
    trigger_frequency: Optional[int] = None
    configuration: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class AgentConfigUpdate(BaseModel):
    """Agent configuration update request."""
    enabled: Optional[bool] = None
    model_name: Optional[str] = None
    prompt_template: Optional[str] = None
    execution_trigger: Optional[str] = None
    trigger_frequency: Optional[int] = None
    configuration: Optional[Dict[str, Any]] = None
    
    @validator('execution_trigger')
    def validate_trigger(cls, v):
        if v is not None and v not in ['background', 'on_demand', 'scheduled']:
            raise ValueError("execution_trigger must be: background, on_demand, or scheduled")
        return v
    
    @validator('trigger_frequency')
    def validate_frequency(cls, v):
        if v is not None and v <= 0:
            raise ValueError("trigger_frequency must be positive")
        return v


class AgentJobCreate(BaseModel):
    """Create agent job request."""
    agent_name: str = Field(..., description="Name of the agent (memory, research)")
    entity_id: UUID = Field(..., description="ID of entity to process")
    entity_type: str = Field(..., description="Type of entity (chat, attachment, document)")
    priority: int = Field(default=5, ge=1, le=10, description="Job priority (1-10)")
    execution_strategy: Literal["parallel", "sequential", "batch"] = Field(
        default="parallel",
        description="Scheduling strategy for job execution"
    )
    depends_on: Optional[UUID] = Field(
        default=None,
        description="Parent job UUID (required for sequential strategy)"
    )
    batch_group: Optional[str] = Field(
        default=None,
        description="Batch group identifier (required for batch strategy)"
    )
    resource_cost: Optional[int] = Field(
        default=None,
        ge=1,
        le=10,
        description="Override resource cost (1-10); defaults from config"
    )
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional job metadata")
    
    @validator("depends_on", always=True)
    def validate_depends_on(cls, v, values):
        if values.get("execution_strategy") == "sequential" and not v:
            raise ValueError("depends_on is required when execution_strategy is 'sequential'")
        return v
    
    @validator("batch_group", always=True)
    def validate_batch_group(cls, v, values):
        if values.get("execution_strategy") == "batch" and not v:
            raise ValueError("batch_group is required when execution_strategy is 'batch'")
        return v


class AgentJobResponse(BaseModel):
    """Agent job creation response."""
    job_id: UUID
    agent_name: str
    entity_id: UUID
    entity_type: str
    status: str
    created_at: datetime


class JobActionResponse(BaseModel):
    """Response for job actions (cancel/retry/delete)."""
    job_id: UUID
    status: str
    message: str
    job: Optional[Dict[str, Any]] = None


class AgentOutputResponse(BaseModel):
    """Agent output response."""
    id: UUID
    agent_name: str
    output_type: str
    content: Dict[str, Any]
    aether_rag_index_name: Optional[str] = None
    entity_id: Optional[UUID] = None
    job_id: Optional[UUID] = None
    created_at: datetime


class AgentStatusResponse(BaseModel):
    """Agent system status."""
    total_agents: int
    enabled_agents: int
    pending_jobs: int
    agents: list[Dict[str, Any]]
