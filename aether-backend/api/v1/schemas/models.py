"""
Model Schemas

Pydantic models for LLM model management endpoints.

@.architecture
Incoming: api/v1/endpoints/models.py --- {LLM provider responses, model configs}
Processing: Pydantic validation and serialization --- {2 jobs: data_validation, serialization}
Outgoing: api/v1/endpoints/models.py --- {ModelInfo, ModelsListResponse, ModelCapabilitiesResponse, ModelConfig validated models}
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field


# =============================================================================
# Model Information Models
# =============================================================================

class ModelInfo(BaseModel):
    """Information about an LLM model."""
    id: str
    name: Optional[str] = None
    provider: Optional[str] = None
    context_window: Optional[int] = None
    supports_vision: bool = False
    supports_functions: bool = False
    description: Optional[str] = None


class ModelsListResponse(BaseModel):
    """Response for models list endpoint."""
    models: List[str]
    count: int = Field(default=0)
    
    class Config:
        json_schema_extra = {
            "example": {
                "models": [
                    "qwen/qwen3-4b-2507",
                    "qwen/qwen3-14b",
                    "gpt-4o"
                ],
                "count": 3
            }
        }


class ModelCapabilitiesResponse(BaseModel):
    """Response for model capabilities endpoint."""
    model: str
    supports_vision: bool
    supports_functions: bool = False
    supports_streaming: bool = True
    context_window: Optional[int] = None
    max_tokens: Optional[int] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "model": "qwen/qwen3-4b-2507",
                "supports_vision": True,
                "supports_functions": False,
                "supports_streaming": True,
                "context_window": 100000,
                "max_tokens": 4096
            }
        }


# =============================================================================
# Model Configuration Models
# =============================================================================

class ModelConfig(BaseModel):
    """Model configuration."""
    primary_chat_model: str
    fallback_chat_model: Optional[str] = None
    primary_embedding_model: str
    fallback_embedding_model: Optional[str] = None


class ModelConfigResponse(BaseModel):
    """Response for model configuration."""
    config: ModelConfig
    available_models: List[str]

