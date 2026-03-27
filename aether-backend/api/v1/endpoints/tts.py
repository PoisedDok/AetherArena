"""
Text-to-Speech API Endpoints

Provides real-time text-to-speech synthesis capabilities.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/tts/engines, /v1/tts/synthesize, /v1/tts/stream, /v1/tts/health, TTSRequest JSON payloads}
Processing: list_tts_engines(), synthesize_speech(), stream_speech(), tts_health(), initialize_engine() --- {JOB_ROUTE}
Outgoing: core/integrations/libraries/tts.py, Frontend (HTTP) --- {TTSIntegration method calls, audio/wav Response, StreamingResponse, TTSEnginesResponse, TTSHealthResponse}
"""

import struct
from core.exceptions import DomainException
from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Body
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel, Field

from api.dependencies import setup_request_context
from core.integrations.libraries.tts import get_tts_integration
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["tts"])


def _pcm16_to_wav(pcm_data: bytes, sample_rate: int = 24000, channels: int = 1) -> bytes:
    """
    Wrap raw PCM16 audio bytes in a proper WAV (RIFF) header.

    Web Audio API's decodeAudioData() requires a container format —
    raw PCM16 will cause a DOMException.  This adds the 44-byte WAV
    header so the browser can decode it.
    """
    bits_per_sample = 16
    byte_rate = sample_rate * channels * (bits_per_sample // 8)
    block_align = channels * (bits_per_sample // 8)
    data_size = len(pcm_data)
    # RIFF header: 44 bytes total
    header = struct.pack(
        '<4sI4s4sIHHIIHH4sI',
        b'RIFF',
        36 + data_size,       # ChunkSize
        b'WAVE',
        b'fmt ',
        16,                   # Subchunk1Size (PCM)
        1,                    # AudioFormat (PCM = 1)
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b'data',
        data_size,
    )
    return header + pcm_data


# =============================================================================
# Schemas
# =============================================================================

class TTSRequest(BaseModel):
    """Request to synthesize text to speech."""
    text: str = Field(..., min_length=1, max_length=10000, description="Text to synthesize")
    engine: Optional[str] = Field("system", description="TTS engine (qwen3, kokoro, system, edge, gtts, openai, elevenlabs)")
    voice: Optional[str] = Field(None, description="Voice ID (engine-specific)")
    language: Optional[str] = Field(None, description="Language override (english/chinese/etc). Qwen3 engines only.")
    api_key: Optional[str] = Field(None, description="API key for commercial engines")
    
    class Config:
        json_schema_extra = {
            "example": {
                "text": "Hello, this is a test of the text to speech system.",
                "engine": "qwen3",
                "voice": "Ryan",
                "language": "english"
            }
        }


class TTSPreviewRequest(BaseModel):
    """Request to preview a TTS voice with a short sample."""
    engine: str = Field("qwen3", description="TTS engine (qwen3, kokoro, system, edge, gtts)")
    voice: str = Field("Ryan", description="Voice name to preview")
    
    class Config:
        json_schema_extra = {
            "example": {
                "engine": "qwen3",
                "voice": "Ryan"
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
    description="Get list of available text-to-speech engines",
    openapi_extra={"is_agent_tool": True})
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
        logger.error("Failed to list TTS engines: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list engines"
        )


# =============================================================================
# TTS Capabilities (Dynamic options for frontend)
# =============================================================================

@router.get(
    "/tts/capabilities",
    summary="Get TTS capabilities for settings UI",
    description="Returns available engines, voices per engine, and supported languages. "
                "Frontend uses this to dynamically populate dropdowns — never hardcodes."
)
async def tts_capabilities(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Single source of truth for TTS dropdown options.

    Returns engines with availability, voices per engine with rich metadata
    (value, label, language), and supported TTS languages.
    """
    try:
        from config.audio_config import TtsConfig

        tts = get_tts_integration()
        runtime_engines = tts.get_available_engines() if tts.is_available() else []
        runtime_set = set(runtime_engines)

        # Engine options with runtime availability
        engine_options = []
        for opt in TtsConfig.get_engine_options():
            engine_options.append({
                **opt,
                "available": opt["value"] in runtime_set,
            })

        return {
            "engines": engine_options,
            "current_engine": tts.get_current_engine() if tts.is_available() else None,
            "voices": {
                "qwen3": TtsConfig.get_qwen3_voice_options(),
                "kokoro": TtsConfig.get_kokoro_voice_options(),
            },
            "languages": TtsConfig.get_supported_languages(),
        }
    except Exception as e:
        logger.error("Failed to get TTS capabilities: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get TTS capabilities"
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
    },
    openapi_extra={"is_agent_tool": True})
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
            engine_kwargs = {}
            if request.voice:
                engine_kwargs["voice"] = request.voice
            if request.engine == "qwen3":
                from config.audio_config import get_audio_config
                audio_cfg = get_audio_config()
                engine_kwargs["model_path"] = audio_cfg.tts.qwen3_model_path
                engine_kwargs["device"] = audio_cfg.tts.qwen3_device
                engine_kwargs["instruct"] = audio_cfg.tts.qwen3_instruct
                engine_kwargs["language"] = request.language or audio_cfg.tts.qwen3_language
            if request.api_key:
                engine_kwargs["api_key"] = request.api_key
            success = tts.initialize_engine(request.engine, **engine_kwargs)
            if not success:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Failed to initialize {request.engine} engine"
                )
        
        # ── Apply per-request voice/language overrides (save+restore) ──
        # The engine is a shared singleton used by both handsfree TTS
        # (WebSocket streaming) and this HTTP endpoint.  Mutating voice/
        # language without restoring would corrupt the handsfree session.
        engine = tts._direct_engine
        saved_voice = getattr(engine, 'current_voice', None) if engine else None
        saved_language = getattr(engine, 'current_language', None) if engine else None
        saved_instruct = getattr(engine, 'instruct', None) if engine else None
        
        audio_data = None
        try:
            if engine and request.voice and hasattr(engine, 'set_voice'):
                engine.set_voice(request.voice)
            if engine and request.language and hasattr(engine, 'set_voice_parameters'):
                engine.set_voice_parameters(language=request.language)
            # Always apply configured instruct for Qwen3 — prevents emotion drift
            # when the engine's instruct was mutated by another caller.
            if engine and request.engine == "qwen3" and hasattr(engine, 'instruct'):
                from config.audio_config import get_audio_config
                cfg_instruct = get_audio_config().tts.qwen3_instruct
                if cfg_instruct:
                    engine.instruct = cfg_instruct
        
            # Synthesize audio
            audio_data = await tts.synthesize_text_async(request.text)
        finally:
            # ── Restore previous engine state ──
            if engine and saved_voice is not None:
                try:
                    engine.set_voice(saved_voice)
                except Exception:
                    pass
            if engine and saved_language is not None:
                try:
                    engine.current_language = saved_language
                except Exception:
                    pass
            if engine and saved_instruct is not None:
                try:
                    engine.instruct = saved_instruct
                except Exception:
                    pass
        
        if audio_data is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Synthesis failed"
            )
        
        # Wrap raw PCM16 in WAV header so browsers can decode it.
        # synthesize_text() returns raw PCM16 bytes; decodeAudioData() needs WAV.
        sample_rate = getattr(engine, '_sample_rate', 24000) if engine else 24000
        wav_data = _pcm16_to_wav(audio_data, sample_rate=sample_rate, channels=1)
        
        logger.info("Synthesized %s characters using %s engine (%s bytes WAV)", len(request.text), request.engine, len(wav_data))
        
        return Response(
            content=wav_data,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=speech.wav",
                "Content-Length": str(len(wav_data))
            }
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Synthesis failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Synthesis failed"
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
                logger.error("Streaming error: %s", e)
                raise
        
        logger.info("Streaming %s characters using %s engine", len(request.text), request.engine)
        
        return StreamingResponse(
            audio_generator(),
            media_type="audio/wav",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no"
            }
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Streaming failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Streaming failed"
        )


# =============================================================================
# Voice Preview
# =============================================================================

# Preview text per voice — native language sample for natural demonstration
_PREVIEW_TEXTS = {
    # Qwen3 voices
    "Ryan": "Hello, I'm Ryan. Welcome to Aether — your intelligent companion.",
    "Aiden": "Hey there, I'm Aiden. Ready to help you with anything you need.",
    "Vivian": "Hello, I'm Vivian. Nice to meet you!",
    "Serena": "Hello, I'm Serena. Let me know how I can help.",
    "Uncle_Fu": "Hello, I'm Uncle Fu. Years of experience at your service.",
    "Dylan": "Hey, I'm Dylan. Let's get started!",
    "Eric": "Hello, I'm Eric. Always happy to help out.",
    "Ono_Anna": "Hello, I'm Ono Anna. Pleased to meet you!",
    "Sohee": "Hello, I'm Sohee. How can I assist you today?",
    # Kokoro voices
    "af_heart": "Hello, this is the Heart voice. Warm and inviting.",
    "af_sky": "Hello, this is the Sky voice. Bright and clear.",
    "am_adam": "Hello, this is Adam. Deep and resonant.",
    "am_michael": "Hello, this is Michael. Smooth and professional.",
}

_DEFAULT_PREVIEW = "Hello, this is a preview of the selected voice."


@router.post(
    "/tts/preview",
    response_class=Response,
    summary="Preview a TTS voice",
    description="Generate a short audio sample for a specific voice. "
                "Used by the settings panel for voice selection preview.",
    responses={
        200: {
            "content": {"audio/wav": {}},
            "description": "Voice preview audio"
        },
        503: {"description": "TTS service not available"}
    }
)
async def preview_voice(
    request: TTSPreviewRequest,
    _context: dict = Depends(setup_request_context)
) -> Response:
    """
    Preview a TTS voice with a short native-language sample.
    
    Generates ~2-5 seconds of audio for the specified voice.
    Does NOT switch the active engine — uses a temporary instance.
    """
    try:
        tts = get_tts_integration()
        
        if not tts.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="TTS service not available"
            )
        
        # Use engine-specific kwargs — must match factory.py init params
        # so previews sound identical to actual handsfree TTS
        engine_kwargs = {"voice": request.voice}
        if request.engine == "qwen3":
            from config.audio_config import get_audio_config
            audio_cfg = get_audio_config()
            engine_kwargs["model_path"] = audio_cfg.tts.qwen3_model_path
            engine_kwargs["device"] = audio_cfg.tts.qwen3_device
            engine_kwargs["instruct"] = audio_cfg.tts.qwen3_instruct
            engine_kwargs["language"] = audio_cfg.tts.qwen3_language
        
        # Initialize the requested engine (reuses cached model if same engine)
        current_engine = tts.get_current_engine()
        if current_engine != request.engine:
            success = tts.initialize_engine(request.engine, **engine_kwargs)
            if not success:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Failed to initialize {request.engine} engine for preview"
                )
        # Get preview text for this voice
        preview_text = _PREVIEW_TEXTS.get(request.voice, _DEFAULT_PREVIEW)
        
        # Save+restore engine state (preview may use different voice than handsfree)
        engine = tts._direct_engine
        saved_voice = getattr(engine, 'current_voice', None) if engine else None
        saved_language = getattr(engine, 'current_language', None) if engine else None
        saved_instruct = getattr(engine, 'instruct', None) if engine else None
        
        audio_data = None
        try:
            if engine and hasattr(engine, 'set_voice'):
                engine.set_voice(request.voice)
            
            # Synthesize preview
            audio_data = await tts.synthesize_text_async(preview_text)
        finally:
            # Restore previous engine state
            if engine and saved_voice is not None:
                try:
                    engine.set_voice(saved_voice)
                except Exception:
                    pass
            if engine and saved_language is not None:
                try:
                    engine.current_language = saved_language
                except Exception:
                    pass
            if engine and saved_instruct is not None:
                try:
                    engine.instruct = saved_instruct
                except Exception:
                    pass
        
        if audio_data is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Voice preview synthesis failed"
            )
        
        # Wrap raw PCM16 in WAV header
        sample_rate = getattr(engine, '_sample_rate', 24000) if engine else 24000
        wav_data = _pcm16_to_wav(audio_data, sample_rate=sample_rate, channels=1)
        
        logger.info("Voice preview: engine=%s, voice=%s, size=%sB WAV", request.engine, request.voice, len(wav_data))
        
        return Response(
            content=wav_data,
            media_type="audio/wav",
            headers={
                "Content-Disposition": f"inline; filename=preview_{request.voice}.wav",
                "Content-Length": str(len(wav_data)),
                "Cache-Control": "public, max-age=3600",  # Cache previews for 1 hour
            }
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Voice preview failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Voice preview failed"
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
        logger.error("Health check failed: %s", e, exc_info=True)
        return TTSHealthResponse(
            healthy=False,
            message="Health check failed. Check server logs for details.",
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
        
        logger.info("Initialized %s TTS engine", engine)
        
        return {
            "success": True,
            "engine": engine,
            "message": f"Engine {engine} initialized successfully"
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Engine initialization failed: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Initialization failed"
        )


