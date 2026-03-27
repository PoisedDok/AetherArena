"""
Model Schemas

Pydantic models for LLM model management endpoints.

@.architecture
Incoming: api/v1/endpoints/models.py --- {LLM provider responses, model configs}
Processing: Pydantic validation and serialization --- {JOB_SERIALIZE, JOB_VALIDATE_SCHEMA}
Outgoing: api/v1/endpoints/models.py --- {ModelInfo, ModelsListResponse, ModelCapabilitiesResponse, ModelConfig validated models}
"""

from typing import List, Optional
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
                    "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
                    "qwen/qwen3-14b",
                    "gpt-4o"
                ],
                "count": 3
            }
        }


class ModelCapabilitiesResponse(BaseModel):
    """Response for model capabilities endpoint.
    
    Fields:
        context_window: User's chosen context window (from settings). Use this as the slider VALUE.
        max_tokens: User's chosen max generation tokens (from settings). Use this as the slider VALUE.
        context_window_max: Model's physical context limit from inference server. Use as slider MAX.
        default_max_tokens: Model's default max generation tokens from inference server.
        default_temperature: Model's default temperature from inference server.
        default_top_p: Model's default top_p from inference server.
        default_top_k: Model's default top_k from inference server.
    """
    model: str
    supports_vision: bool
    supports_functions: bool = False
    supports_streaming: bool = True
    context_window: Optional[int] = None
    max_tokens: Optional[int] = None
    # Physical model limits from inference server (for slider bounds)
    context_window_max: Optional[int] = None
    default_max_tokens: Optional[int] = None
    default_temperature: Optional[float] = None
    default_top_p: Optional[float] = None
    default_top_k: Optional[int] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "model": "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
                "supports_vision": True,
                "supports_functions": False,
                "supports_streaming": True,
                "context_window": 100000,
                "max_tokens": 4096,
                "context_window_max": 131072,
                "default_max_tokens": 8192,
                "default_temperature": 0.7,
                "default_top_p": 0.9,
                "default_top_k": 40
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

