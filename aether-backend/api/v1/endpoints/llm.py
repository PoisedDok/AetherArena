"""
LLM Proxy Endpoint

Provides a backend LLM endpoint that routes requests to configured inference providers.
Edge functions call this instead of calling the inference provider directly.

@.architecture
Incoming: Supabase Edge Functions, Internal Services --- {ChatCompletionRequest, EmbeddingRequest}
Processing: route to configured LLM provider (Aether Inference, Ollama, etc.) --- {2 jobs: JOB_HTTP_REQUEST, JOB_ROUTE}
Outgoing: Aether Inference, Ollama, or other configured providers --- {ChatCompletionResponse, EmbeddingResponse}
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, model_validator
from typing import List, Dict, Any, Optional, Union, Literal

from api.dependencies import (
    setup_request_context,
    get_runtime_settings,
)
from config.settings import Settings
from monitoring import get_logger
from core.exceptions import DomainException
from data.network.llm_gateway import get_llm_gateway
from core.domain.gateway_interfaces import ILlmProviderGateway

logger = get_logger(__name__)
router = APIRouter(
    prefix="/llm",
    tags=["llm"],
)

# Request/Response Models (OpenAI-compatible)

class ImageUrl(BaseModel):
    """OpenAI-compatible image URL payload."""
    url: str


class ContentPart(BaseModel):
    """OpenAI-compatible content part for multimodal messages."""
    type: Literal["text", "image_url"]
    text: Optional[str] = None
    image_url: Optional[ImageUrl] = None

    @model_validator(mode="after")
    def validate_part(self) -> "ContentPart":
        if self.type == "text" and not (self.text and self.text.strip()):
            raise ValueError("text content part requires non-empty 'text'")
        if self.type == "image_url" and not self.image_url:
            raise ValueError("image_url content part requires 'image_url'")
        return self


class Message(BaseModel):
    """Chat message."""
    role: Literal["system", "user", "assistant", "tool"]
    content: Optional[Union[str, List[ContentPart]]] = None
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None


class ChatCompletionRequest(BaseModel):
    """Chat completion request (OpenAI-compatible)."""
    model: str
    messages: List[Message]
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    max_completion_tokens: Optional[int] = None  # Added for newer OpenAI SDK compatibility
    top_p: float = 1.0
    frequency_penalty: float = 0.0
    presence_penalty: float = 0.0
    stop: Optional[Union[str, List[str]]] = None
    stream: bool = False
    response_format: Optional[Dict[str, Any]] = None
    tools: Optional[List[Dict[str, Any]]] = None  # Added for tool support
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None  # Added for tool support

    @model_validator(mode="after")
    def handle_max_tokens(self) -> "ChatCompletionRequest":
        # Consolidate max_tokens and max_completion_tokens
        if self.max_completion_tokens is not None and self.max_tokens is None:
            self.max_tokens = self.max_completion_tokens
        return self


class ChatCompletionChoice(BaseModel):
    """Chat completion choice."""
    index: int
    message: Message
    finish_reason: Optional[str] = None


class ChatCompletionUsage(BaseModel):
    """Token usage statistics."""
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ChatCompletionResponse(BaseModel):
    """Chat completion response (OpenAI-compatible)."""
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[ChatCompletionChoice]
    usage: Optional[ChatCompletionUsage] = None


class EmbeddingRequest(BaseModel):
    """Embedding generation request."""
    input: Union[str, List[str]]
    model: str = "text-embedding-3-small"


class EmbeddingData(BaseModel):
    """Single embedding."""
    object: str = "embedding"
    embedding: List[float]
    index: int


class EmbeddingResponse(BaseModel):
    """Embedding generation response."""
    object: str = "list"
    data: List[EmbeddingData]
    model: str
    usage: Optional[Dict[str, int]] = None


@router.post(
    "/chat/completions",
    summary="Create chat completion",
    description="Routes a chat completion request to the configured LLM provider "
                "(Aether Inference, LM Studio, Ollama, or any OpenAI-compatible endpoint).",
)
async def create_chat_completion(
    request: ChatCompletionRequest,
    settings: Settings = Depends(get_runtime_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ILlmProviderGateway = Depends(get_llm_gateway)
):
    """
    Create a chat completion using the configured LLM provider.
    
    This endpoint routes requests to the appropriate provider:
    - Aether Inference (default, built-in at :7090)
    - LM Studio / Ollama / other OpenAI-compatible endpoints (user-configured)
    
    Args:
        request: ChatCompletionRequest with messages and parameters
        
    Returns:
        ChatCompletionResponse with generated completion
        
    Raises:
        HTTPException: If LLM request fails
    """
    # Get provider URL from settings
    provider_url = settings.llm.api_base
    api_key = settings.llm.api_key
    
    # Route to aether-inference when it is selected as the main provider
    llm_provider = (settings.llm.provider or "").strip().lower()
    if llm_provider == "aether_inference":
        provider_url = settings.inference_url
        api_key = "not-needed"
    
    # Use configured model if not specified
    if not request.model or request.model == "default":
        request.model = settings.llm.model
    
    logger.info(
        f"Routing chat completion to {provider_url} (model: {request.model}, "
        f"messages: {len(request.messages)}, temp: {request.temperature})"
    )
    
    try:
        # Use extended timeout for chat completions (LLM processing)
        llm_timeout = settings.http_client.llm_timeout * 2  # 2x = 120s (was 10x = 600s, too high)
        logger.debug("LLM request start: timeout=%s, model=%s, msg_count=%s", llm_timeout, request.model, len(request.messages))
        
        # Configure connection limits to prevent resource exhaustion
        # Limits and pooling are now managed globally inside the HTTP Gateway.
        # Build request payload, excluding None values.
        # stream: bool = False is always present (Pydantic guarantees non-None).
        payload = request.model_dump(exclude_none=True)
        
        is_streaming = payload.get('stream', False)
        logger.debug("Payload prepared: size=%s, stream=%s", len(str(payload)), is_streaming)
        
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        # ARCHITECTURAL FIX: Handle streaming and non-streaming paths separately
        if is_streaming:
            # Streaming path: proxy SSE chunks directly
            async def stream_proxy():
                async for chunk in gateway.generate_completion_stream(
                    url=f"{provider_url}/chat/completions",
                    payload=payload,
                    headers=headers,
                    timeout=llm_timeout
                ):
                    yield f"{chunk}\n"
            
            from fastapi.responses import StreamingResponse
            return StreamingResponse(
                stream_proxy(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no"
                }
            )
        
        # Non-streaming path
        completion = await gateway.generate_completion(
            url=f"{provider_url}/chat/completions",
            payload=payload,
            headers=headers,
            timeout=llm_timeout
        )
        
        logger.info(
            f"✅ Chat completion successful (finish_reason: "
            f"{completion.get('choices', [{}])[0].get('finish_reason')})"
        )
        
        return ChatCompletionResponse(**completion)
            
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Unexpected error in chat completion: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate completion. Check server logs for details."
        )


@router.post("/embeddings", response_model=EmbeddingResponse)
async def create_embeddings(
    request: EmbeddingRequest,
    settings: Settings = Depends(get_runtime_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ILlmProviderGateway = Depends(get_llm_gateway)
) -> EmbeddingResponse:
    """
    Generate embeddings using the backend embedding service.
    
    Routes to the configured embedding service URL.
    
    Args:
        request: EmbeddingRequest with text(s) to embed
        
    Returns:
        EmbeddingResponse with embeddings
        
    Raises:
        HTTPException: If embedding generation fails
    """
    # Proxy directly to Perplexica's local ONNX embedding service (already OpenAI-compatible)
    embedding_url = settings.embedding_service.service_url
    
    # Convert to list if single string
    texts = [request.input] if isinstance(request.input, str) else request.input
    
    logger.info("Generating embeddings for %s text(s)", len(texts))
    
    try:
        embedding_timeout = settings.http_client.embedding_timeout
        result = await gateway.generate_embeddings(
            url=embedding_url,
            payload={
                "input": texts,
                "model": request.model or settings.embedding_service.model,
            },
            timeout=embedding_timeout
        )
        
        # Response is already OpenAI-compatible — extract and re-wrap with our schema
        data = [
            EmbeddingData(
                object="embedding",
                embedding=item["embedding"],
                index=item["index"]
            )
            for item in result["data"]
        ]
        
        logger.info("Generated %s embeddings", len(data))
        
        return EmbeddingResponse(
            object="list",
            data=data,
            model=result.get("model", settings.embedding_service.model),
            usage=result.get("usage", {"prompt_tokens": 0, "total_tokens": 0})
        )
            
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Unexpected error in embedding generation: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate embeddings. Check server logs for details."
        )


@router.get(
    "/config",
    summary="Get LLM configuration",
    description="Returns current LLM provider URL, model names, and locality flag.",
)
async def get_llm_config(
    settings: Settings = Depends(get_runtime_settings),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Get current LLM configuration including provider details.
    """
    try:
        return {
            "provider": settings.llm.api_base,
            "model": settings.llm.model,
            "summarizer_model": settings.llm.summarizer_model,
            "embedding_model": settings.llm.embedding_model,
            "is_local": "localhost" in settings.llm.api_base or "127.0.0.1" in settings.llm.api_base or "host.docker.internal" in settings.llm.api_base
        }
    except Exception as e:
        logger.error("Failed to retrieve LLM config: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve LLM configuration. Check server logs for details."
        )


@router.get(
    "/models",
    summary="List available LLM models",
    description="Proxies all models from the configured LLM provider (Aether Inference by default). "
                "Falls back to configured model names if provider is unreachable.",
)
async def list_models(
    settings: Settings = Depends(get_runtime_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ILlmProviderGateway = Depends(get_llm_gateway)
) -> Dict[str, Any]:
    """
    List available models.
    
    Proxies ALL models from configured LLM provider (Aether Inference by default).
    This allows Perplexica and other services to discover all available models dynamically.
    """
    provider_url = settings.llm.api_base
    
    try:
        # Query configured provider for all available models
        return await gateway.fetch_models(
            url=f"{provider_url}/models",
            headers={},
            timeout=5.0
        )
    except Exception as e:
        logger.error("Failed to fetch models: %s", e)
        # Fallback to configured models
        return {
            "object": "list",
            "data": [
                {
                    "id": settings.llm.model,
                    "object": "model",
                    "created": 0,
                    "owned_by": "local"
                },
                {
                    "id": settings.llm.embedding_model,
                    "object": "model",
                    "created": 0,
                    "owned_by": "local"
                }
            ]
        }


@router.get(
    "/health",
    summary="LLM provider health check",
    description="Tests connectivity to the configured LLM provider and embedding service.",
)
async def llm_health(
    settings: Settings = Depends(get_runtime_settings),
    _context: dict = Depends(setup_request_context),
    gateway: ILlmProviderGateway = Depends(get_llm_gateway)
) -> Dict[str, Any]:
    """
    Check LLM provider health.
    
    Tests connectivity to configured LLM provider and embedding service.
    """
    provider_url = settings.llm.api_base
    # Embedding service is now hosted inside Perplexica Docker container
    embedding_url = settings.embedding_service.service_url
    
    health_status = {
        "llm_provider": {
            "url": provider_url,
            "status": "unknown",
            "model": settings.llm.model
        },
        "embedding_service": {
            "url": embedding_url,
            "status": "unknown"
        }
    }
    
    # Use short timeout for health checks
    health_timeout = 5.0
    try:
        await gateway.verify_provider(f"{provider_url}/models", {}, timeout=health_timeout)
        health_status["llm_provider"]["status"] = "healthy"
    except Exception as e:
        logger.warning("LLM provider health check failed: %s", e)
        health_status["llm_provider"]["status"] = "unhealthy"
        health_status["llm_provider"]["error"] = "Provider health check failed."
    
    # Check embedding service (GET /api/embeddings returns health info)
    try:
        data = await gateway.fetch_models(embedding_url, {}, timeout=health_timeout)
        health_status["embedding_service"]["status"] = data.get("status", "unhealthy")
        health_status["embedding_service"]["model"] = data.get("default_model")
    except Exception as e:
        logger.warning("Embedding service health check failed: %s", e)
        health_status["embedding_service"]["status"] = "unhealthy"
        health_status["embedding_service"]["error"] = "Provider health check failed."
    
    overall_healthy = all(
        svc["status"] == "healthy" 
        for svc in [health_status["llm_provider"], health_status["embedding_service"]]
    )
    
    return {
        "status": "healthy" if overall_healthy else "degraded",
        "services": health_status
    }

