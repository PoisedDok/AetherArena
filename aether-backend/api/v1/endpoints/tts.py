"""
Text-to-Speech API Endpoints

Provides real-time text-to-speech synthesis capabilities.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/tts/engines, /v1/tts/synthesize, /v1/tts/stream, /v1/tts/health, TTSRequest JSON payloads}
Processing: list_tts_engines(), synthesize_speech(), stream_speech(), tts_health(), initialize_engine() --- {4 jobs: audio_synthesis, engine_management, health_checking, streaming_synthesis}
Outgoing: core/integrations/libraries/tts.py, Frontend (HTTP) --- {TTSIntegration method calls, audio/wav Response, StreamingResponse, TTSEnginesResponse, TTSHealthResponse}
"""

from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Body
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, Field

from api.dependencies import setup_request_context
from core.integrations.libraries.tts import get_tts_integration
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["tts"])


# =============================================================================
# Schemas
# =============================================================================

class TTSRequest(BaseModel):
    """Request to synthesize text to speech."""
    text: str = Field(..., min_length=1, max_length=10000, description="Text to synthesize")
    engine: Optional[str] = Field("system", description="TTS engine (system, edge, gtts, openai, elevenlabs)")
    voice: Optional[str] = Field(None, description="Voice ID (engine-specific)")
    api_key: Optional[str] = Field(None, description="API key for commercial engines")
    
    class Config:
        json_schema_extra = {
            "example": {
                "text": "Hello, this is a test of the text to speech system.",
                "engine": "edge",
                "voice": "en-US-AriaNeural"
            }
        }


class TTSEnginesResponse(BaseModel):
    """List of available TTS engines."""
    engines: list[str]
    current_engine: Optional[str]
    available: bool


class TTSHealthResponse(BaseModel):
    """TTS system health status."""
    healthy: bool
    message: str
    current_engine: Optional[str]
    available_engines: list[str]


# =============================================================================
# List Available Engines
# =============================================================================

@router.get(
    "/tts/engines",
    response_model=TTSEnginesResponse,
    summary="List available TTS engines",
    description="Get list of available text-to-speech engines"
)
async def list_tts_engines(
    _context: dict = Depends(setup_request_context)
) -> TTSEnginesResponse:
    """
    List available TTS engines.
    
    Returns available engines and currently active engine.
    """
    try:
        tts = get_tts_integration()
        
        return TTSEnginesResponse(
            engines=tts.get_available_engines() if tts.is_available() else [],
            current_engine=tts.get_current_engine(),
            available=tts.is_available()
        )
        
    except Exception as e:
        logger.error(f"Failed to list TTS engines: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list engines: {str(e)}"
        )


# =============================================================================
# Synthesize Text to Speech
# =============================================================================

@router.post(
    "/tts/synthesize",
    response_class=Response,
    summary="Synthesize text to speech",
    description="Convert text to audio using specified TTS engine",
    responses={
        200: {
            "content": {"audio/wav": {}},
            "description": "Audio file generated successfully"
        },
        503: {"description": "TTS service not available"}
    }
)
async def synthesize_speech(
    request: TTSRequest,
    _context: dict = Depends(setup_request_context)
) -> Response:
    """
    Synthesize text to speech.
    
    Returns audio data as WAV file.
    """
    try:
        tts = get_tts_integration()
        
        if not tts.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="TTS service not available"
            )
        
        # Initialize engine if needed or if different from current
        if tts.get_current_engine() != request.engine:
            success = tts.initialize_engine(
                request.engine,
                api_key=request.api_key
            )
            if not success:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Failed to initialize {request.engine} engine"
                )
        
        # Synthesize audio
        audio_data = await tts.synthesize_text_async(request.text)
        
        if audio_data is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Synthesis failed"
            )
        
        logger.info(f"Synthesized {len(request.text)} characters using {request.engine} engine")
        
        return Response(
            content=audio_data,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=speech.wav",
                "Content-Length": str(len(audio_data))
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Synthesis failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Synthesis failed: {str(e)}"
        )


# =============================================================================
# Stream Text to Speech
# =============================================================================

@router.post(
    "/tts/stream",
    summary="Stream text to speech",
    description="Stream audio synthesis in real-time",
    responses={
        200: {
            "content": {"audio/wav": {}},
            "description": "Audio stream"
        }
    }
)
async def stream_speech(
    request: TTSRequest,
    _context: dict = Depends(setup_request_context)
) -> StreamingResponse:
    """
    Stream text to speech synthesis.
    
    Returns streaming audio response.
    """
    try:
        tts = get_tts_integration()
        
        if not tts.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="TTS service not available"
            )
        
        # Initialize engine if needed
        if tts.get_current_engine() != request.engine:
            success = tts.initialize_engine(
                request.engine,
                api_key=request.api_key
            )
            if not success:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Failed to initialize {request.engine} engine"
                )
        
        # Stream synthesis
        async def audio_generator():
            """Generate audio chunks."""
            try:
                async for chunk in tts.stream_synthesis(request.text):
                    yield chunk
            except Exception as e:
                logger.error(f"Streaming error: {e}")
                raise
        
        logger.info(f"Streaming {len(request.text)} characters using {request.engine} engine")
        
        return StreamingResponse(
            audio_generator(),
            media_type="audio/wav",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no"
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Streaming failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Streaming failed: {str(e)}"
        )


# =============================================================================
# TTS Health Check
# =============================================================================

@router.get(
    "/tts/health",
    response_model=TTSHealthResponse,
    summary="TTS health check",
    description="Check TTS system health and availability"
)
async def tts_health(
    _context: dict = Depends(setup_request_context)
) -> TTSHealthResponse:
    """
    Check TTS health.
    
    Returns health status and available engines.
    """
    try:
        tts = get_tts_integration()
        health_data = await tts.check_health()
        
        return TTSHealthResponse(**health_data)
        
    except Exception as e:
        logger.error(f"Health check failed: {e}", exc_info=True)
        return TTSHealthResponse(
            healthy=False,
            message=f"Health check failed: {str(e)}",
            current_engine=None,
            available_engines=[]
        )


# =============================================================================
# Initialize Engine
# =============================================================================

@router.post(
    "/tts/initialize",
    summary="Initialize TTS engine",
    description="Initialize specific TTS engine with configuration"
)
async def initialize_engine(
    engine: str = Body(..., embed=True, description="Engine name"),
    api_key: Optional[str] = Body(None, embed=True, description="API key for commercial engines"),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Initialize TTS engine.
    
    Allows pre-initialization of engines before synthesis.
    """
    try:
        tts = get_tts_integration()
        
        if not tts.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="TTS service not available"
            )
        
        success = tts.initialize_engine(engine, api_key=api_key)
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Failed to initialize {engine} engine"
            )
        
        logger.info(f"Initialized {engine} TTS engine")
        
        return {
            "success": True,
            "engine": engine,
            "message": f"Engine {engine} initialized successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Engine initialization failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Initialization failed: {str(e)}"
        )


