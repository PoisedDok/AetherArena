# @.architecture
# Incoming: runtime engine + optional cache/db/services --- {Any, Optional[Any]}
# Processing: Wire clean-architecture WebSocket components and handlers --- {3 jobs: JOB_WIRE_DEPENDENCIES, JOB_LOAD_CONFIG, JOB_CREATE_SERVER}
# Outgoing: WebSocketHub instance --- {WebSocketHub, python}

"""
WebSocket Layer Factory - Dependency injection and component wiring

Creates and wires all WebSocket layer components following clean architecture.

Usage:
    from ws.factory import create_websocket_hub
    
    hub = create_websocket_hub(
        runtime=runtime_engine,
        cache_client=redis_client,
        database_gateway=db_gateway,
        history_service=history_service,
    )
"""

from typing import Any, Optional
import logging
import asyncio

logger = logging.getLogger(__name__)

# Per-client LLM request serialization (FAIL_FAST - one request at a time)
client_llm_locks = {}  # {client_id: asyncio.Lock()}

from ws.infrastructure.cache import RedisAdapter, MemoryFallbackCache
from ws.infrastructure.persistence import TrailRepositoryAdapter
from ws.application import (
    StreamOrchestrator,
    TrailCoordinator,
    SessionBuilder,
    CacheService,
    UserMessagePersister,
    AssistantTextFlusher,
    RuntimeSettingsApplicator,
    ChatSummarizationService,
)
from ws.application.lifecycle import TaskManager, RequestMapper
from ws.presentation import MessageHandler, ControlHandler, AudioHandler, ContextHandler, TrailEmitter, StreamEmitter
from ws.presentation.router import Router
from ws.presentation.hub import WebSocketHub
from ws.config.constants import PRESENCE_TTL, SESSION_TTL, COUNTER_TTL


async def create_websocket_hub(
    *,
    runtime: Any,
    cache_client: Optional[Any] = None,
    redis_settings: Optional[Any] = None,
    history_service: Optional[Any] = None,
    database_gateway: Optional[Any] = None,
    settings: Optional[Any] = None,
    memory_service: Optional[Any] = None,
    tts_integration: Optional[Any] = None,
) -> WebSocketHub:
    """
    Create fully wired WebSocket hub with clean architecture.
    
    NOTE: Now async to support lazy-loading of handsfree models based on user preference.
    
    Args:
        runtime: RuntimeEngine instance
        cache_client: Optional Redis client
        redis_settings: Optional Redis settings
        history_service: Optional chat history service
        database_gateway: Optional database persistence gateway
        settings: Optional Settings instance (for audio config)
        memory_service: Optional MemoryService for global memory injection (provided by caller)
        tts_integration: Optional TTS integration instance (provided by caller)
        
    Returns:
        WebSocketHub instance with all dependencies wired
    """
    # Infrastructure layer
    cache_adapter = RedisAdapter(cache_client) if cache_client else MemoryFallbackCache()
    
    trail_repo_adapter = None
    chat_repository = None
    if database_gateway:
        from data.database.repositories.trail import TrailRepository
        from data.database.repositories.chat import ChatRepository
        trail_repo = TrailRepository(database_gateway)
        trail_repo_adapter = TrailRepositoryAdapter(trail_repo)
        chat_repository = ChatRepository(database_gateway)

    # Configure global memory injection service (owned by caller; avoid WS factory importing application services).
    if memory_service is not None:
        try:
            from core.runtime.memory_injector import set_memory_service
            set_memory_service(memory_service)
            logger.info("✅ MemoryService wired for global memory injection")
        except (ImportError, AttributeError, TypeError) as exc:
            logger.warning("Failed to configure MemoryService for memory injection: %s", exc)
    
    # Extract TTL settings
    presence_ttl = getattr(redis_settings, "presence_ttl_seconds", PRESENCE_TTL) if redis_settings else PRESENCE_TTL
    session_ttl = getattr(redis_settings, "session_ttl_seconds", SESSION_TTL) if redis_settings else SESSION_TTL
    counter_ttl = getattr(redis_settings, "counter_ttl_seconds", COUNTER_TTL) if redis_settings else COUNTER_TTL
    
    # Application layer
    cache_service = CacheService(
        cache_adapter=cache_adapter,
        presence_ttl=presence_ttl,
        session_ttl=session_ttl,
        counter_ttl=counter_ttl,
    )
    
    task_manager = TaskManager()
    request_mapper = RequestMapper()
    
    trail_coordinator = TrailCoordinator(
        trail_repository_adapter=trail_repo_adapter,
    )
    
    # Application services (extracted concerns for testability)
    user_message_persister = UserMessagePersister(chat_repository=chat_repository)
    assistant_text_flusher = AssistantTextFlusher(chat_repository=chat_repository)
    settings_applicator = RuntimeSettingsApplicator()
    summarization_service = ChatSummarizationService(chat_repository=chat_repository)

    stream_orchestrator = StreamOrchestrator(
        runtime=runtime,
        trail_coordinator=trail_coordinator,
        cache_service=cache_service,
        chat_repository=chat_repository,
        user_message_persister=user_message_persister,
        assistant_text_flusher=assistant_text_flusher,
        settings_applicator=settings_applicator,
        summarization_service=summarization_service,
    )
    
    session_builder = SessionBuilder(
        trail_repository=trail_repo_adapter,
        chat_repository=chat_repository,
    )
    
    # Presentation layer emitters
    trail_emitter = TrailEmitter()
    stream_emitter = StreamEmitter()
    
    # Command executor
    from ws.presentation.command_executor import CommandExecutor
    command_executor = CommandExecutor(
        stream_emitter=stream_emitter,
        trail_emitter=trail_emitter,
    )
    
    # TTS coordinator (handsfree mode) - initialize before MessageHandler
    tts_coordinator = None
    tts_config = None
    
    message_handler = MessageHandler(
        stream_orchestrator=stream_orchestrator,
        command_executor=command_executor,
        task_manager=task_manager,
        request_mapper=request_mapper,
        cache_service=cache_service,
        runtime=runtime,  # For context monitoring
        chat_repository=chat_repository,  # For loading artifacts
        tts_coordinator=tts_coordinator,  # Will be set after audio initialization
        tts_config=tts_config,  # Will be set after audio initialization
    )
    
    control_handler = ControlHandler(
        runtime=runtime,
        task_manager=task_manager,
        request_mapper=request_mapper,
        cache_service=cache_service,
    )
    
    # Audio processing services (handsfree mode)
    audio_processor = None
    hub_ref = {'hub': None}  # Mutable reference for closure
    
    # CRITICAL: Only initialize audio services if handsfree mode is enabled
    # Lazy loading saves ~2GB memory + 30s startup time
    handsfree_enabled = False
    
    if database_gateway:
        try:
            from data.database.repositories.preferences import PreferencesRepository
            prefs_repo = PreferencesRepository(database_gateway)
            handsfree_pref = await prefs_repo.get_preference(
                preference_key="handsfree_enabled",
                user_id="default_user",
                default_value={"enabled": False}
            )
            if isinstance(handsfree_pref, dict):
                handsfree_enabled = bool(handsfree_pref.get("enabled") is True)
            else:
                handsfree_enabled = handsfree_pref is True
            logger.info("Handsfree mode preference: %s", handsfree_enabled)
        except Exception as e:
            logger.warning("Failed to check handsfree preference, defaulting to disabled: %s", e)
            handsfree_enabled = False
    else:
        logger.warning("No database gateway - handsfree mode disabled by default")
    
    if not handsfree_enabled:
        logger.info("⏭️  Handsfree mode disabled - skipping STT/TTS/VAD/WakeWord model loading")
    else:
        logger.info("✅ Handsfree mode enabled - loading audio services...")
    
    try:
        import os
        from ws.domain.audio import (
            OpusDecoder,
            PyannotVadService,
            WhisperSttService,
            AudioProcessingService,
        )
        
        # Get HuggingFace token from environment
        hf_token = os.getenv("HUGGINGFACE_TOKEN")
        if not hf_token:
            logger.warning("HUGGINGFACE_TOKEN not set - audio processing will be disabled")
        elif not handsfree_enabled:
            # Skip initialization if handsfree disabled
            pass
        else:
            # HIGH FIX: Load audio config from settings (NO HARDCODED VALUES)
            from config.audio_config import get_audio_config
            audio_cfg = settings.audio if settings else get_audio_config()
            
            # Initialize TTS integration for handsfree mode (provided by caller to keep ws layer clean).
            tts_coordinator = None  # Will be set if TTS available
            
            if tts_integration is None:
                logger.warning("TTS integration not provided - handsfree TTS will be disabled")
                tts_config = None
            elif tts_integration.is_available():
                tts_config = audio_cfg.tts
                # Build engine-specific kwargs from central config
                engine_kwargs = {"voice": tts_config.voice}
                if tts_config.engine == "qwen3":
                    engine_kwargs["model_path"] = tts_config.qwen3_model_path
                    engine_kwargs["device"] = tts_config.qwen3_device
                    engine_kwargs["instruct"] = tts_config.qwen3_instruct
                    engine_kwargs["language"] = tts_config.qwen3_language

                success = tts_integration.initialize_engine(
                    engine_name=tts_config.engine,
                    **engine_kwargs
                )
                if success:
                    logger.info("TTS integration initialized: %s (voice: %s)", tts_config.engine, tts_config.voice)
                    
                    # Initialize TTS coordinator (per-client service manager)
                    from ws.domain.audio.services.tts_coordinator import TTSCoordinator
                    tts_coordinator = TTSCoordinator(
                        tts_integration=tts_integration,
                        tts_config=tts_config
                    )
                    
                    # Update MessageHandler with TTS coordinator
                    message_handler._tts_coordinator = tts_coordinator
                    message_handler._tts_config = tts_config
                else:
                    logger.warning("Failed to initialize TTS engine: %s", tts_config.engine)
                    tts_config = None
            else:
                logger.warning("RealtimeTTS not available - handsfree TTS will be disabled")
                tts_config = None
            
            # Initialize audio services with config
            opus_decoder = OpusDecoder(
                target_sr=audio_cfg.opus.target_sample_rate,
                max_chunk_size_mb=audio_cfg.opus.max_chunk_size_mb
            )
            vad_service = PyannotVadService(
                model_id=audio_cfg.vad.model_id,
                device=audio_cfg.vad.device,
                hf_token=hf_token,
                min_duration_on=audio_cfg.vad.min_duration_on,
                min_duration_off=audio_cfg.vad.min_duration_off
            )
            stt_service = WhisperSttService(
                model_id=audio_cfg.stt.model_id,
                device=audio_cfg.stt.device
            )
            
            # Transcription callback (sends STT result back to client AND integrates with chat)
            async def on_transcript(client_id: str, text: str) -> None:
                """
                Send transcription result to client via WebSocket and integrate with chat flow.
                
                Direct STT → LLM flow. VAD handles segmentation (no utterance buffer needed).
                
                Two actions:
                1. Send STT event to frontend for visual feedback (handsfree overlay)
                2. Create user message in active chat and trigger LLM response
                """
                if not hub_ref['hub']:
                    logger.warning("Hub not initialized, cannot send transcription: %s", client_id[:8])
                    return
                
                # Get client from hub
                client = hub_ref['hub'].clients.get(client_id)
                if not client:
                    logger.warning("Client %s not found, cannot send transcription", client_id[:8])
                    return
                
                # Filter out internal wake word marker
                if text == "__WAKE_WORD_DETECTED__":
                    # Send wake word event to frontend for visual feedback
                    wake_word_message = {
                        'role': 'assistant',
                        'type': 'wake-word-detected',
                        'timestamp': __import__('time').time(),
                    }
                    await hub_ref['hub'].send_to_client(client, wake_word_message)
                    logger.info("Wake word event sent: %s", client_id[:8])
                    return
                
                # Filter out internal sleep word marker
                if text == "__SLEEP_WORD_DETECTED__":
                    # Send sleep word event to frontend to disable handsfree
                    sleep_word_message = {
                        'role': 'assistant',
                        'type': 'sleep-word-detected',
                        'timestamp': __import__('time').time(),
                    }
                    await hub_ref['hub'].send_to_client(client, sleep_word_message)
                    logger.info("Sleep word event sent: %s", client_id[:8])
                    return
                
                # Send STT result as WebSocket message for visual feedback
                stt_message = {
                    'role': 'assistant',
                    'type': 'stt-final',  # Matches frontend event name
                    'text': text,
                    'final': True,
                    'timestamp': __import__('time').time(),
                }
                
                success = await hub_ref['hub'].send_to_client(client, stt_message)
                if success:
                    logger.info("Transcription sent: %s -> '%s'", client_id[:8], text)
                else:
                    logger.warning("Failed to send transcription to %s", client_id[:8])
                    return
                
                # Direct STT → LLM flow (no utterance buffer - VAD handles segmentation)
                # Get message_handler from factory context
                message_handler = hub_ref.get('message_handler')
                if not message_handler:
                    logger.warning("MessageHandler not available, handsfree message won't trigger LLM")
                    return
                
                # Get active chat_id from client state (stored when chat window opens)
                chat_id = getattr(client, 'active_chat_id', None)
                if not chat_id:
                    logger.warning("No active chat for %s, handsfree message won't persist", client_id[:8])
                    # Still process without chat_id - will use default session
                
                # Create user message object (mimics frontend message structure)
                import uuid
                from ws.protocols import ClientMessage
                
                user_message = ClientMessage(
                    role='user',
                    content=text,
                    id=str(uuid.uuid4()),
                    chat_id=chat_id,
                    correlation_id=f'handsfree-{str(uuid.uuid4())[:8]}',  # Set handsfree correlation_id for TTS detection
                    image=None,
                )
                
                # LLM Request Serialization: One request at a time per client (FAIL_FAST)
                lock = client_llm_locks.setdefault(client_id, asyncio.Lock())
                
                if lock.locked():
                    logger.warning("LLM busy for %s, dropping request: '%s'", client_id[:8], text)
                    return  # FAIL_FAST - drop concurrent requests
                
                # Handle message through normal chat flow
                try:
                    async with lock:
                        await message_handler.handle_user_message(
                            ws=client.ws,  # CRITICAL FIX: Client dataclass uses 'ws', not 'websocket'
                            client_id=client_id,
                            message=user_message,
                        )
                    logger.info("Handsfree message integrated with chat: %s -> '%s'", client_id[:8], text)
                    
                except (RuntimeError, AttributeError, TypeError, ValueError, OSError, ConnectionError) as e:
                    logger.error("Failed to integrate handsfree with chat: %s", e, exc_info=True)
            
            # CRITICAL FIX: Interruption detection callback (backend → frontend event)
            # Notifies frontend when user speaks during TTS playback
            async def on_interruption(client_id: str):
                """Emit interruption-detected event to frontend via WebSocket."""
                if not hub_ref['hub']:
                    logger.warning("Hub not initialized, cannot send interruption event: %s", client_id[:8])
                    return
                
                # Get client from hub
                client = hub_ref['hub'].clients.get(client_id)
                if not client:
                    logger.warning("Client %s not found, cannot send interruption event", client_id[:8])
                    return
                
                # Send interruption event to frontend
                interruption_message = {
                    'role': 'assistant',
                    'type': 'interruption-detected',
                    'timestamp': __import__('time').time(),
                }
                await hub_ref['hub'].send_to_client(client, interruption_message)
                logger.info("Interruption event sent: %s", client_id[:8])
            
            # Wake word service (openWakeWord) - use config
            from ws.domain.audio.services.wake_word_service import WakeWordService
            
            wake_word_service = WakeWordService(
                model_name=audio_cfg.wake_word.model_name,
                threshold=audio_cfg.wake_word.threshold,
                inference_framework=audio_cfg.wake_word.inference_framework,
                enable_vad=audio_cfg.wake_word.enable_vad,
                vad_threshold=audio_cfg.wake_word.vad_threshold,
                expected_sample_rate=audio_cfg.wake_word.expected_sample_rate,
                frame_duration_ms=audio_cfg.wake_word.frame_duration_ms,
                max_buffer_frames=audio_cfg.wake_word.max_buffer_frames,
            )
            
            audio_processor = AudioProcessingService(
                opus_decoder=opus_decoder,
                vad_service=vad_service,
                stt_service=stt_service,
                wake_word_service=wake_word_service,
                on_transcript=on_transcript,
                on_interruption=on_interruption,
                conversation_timeout=audio_cfg.handsfree.conversation_timeout_seconds,
                cache_adapter=cache_adapter,
                cache_namespace=audio_cfg.handsfree.cache_namespace,
                max_buffer_seconds=audio_cfg.handsfree.max_buffer_seconds,
                sample_rate=audio_cfg.handsfree.sample_rate,
                circuit_breaker_enabled=audio_cfg.handsfree.circuit_breaker_enabled,
                circuit_breaker_threshold=audio_cfg.handsfree.circuit_breaker_failure_threshold,
                circuit_breaker_reset_timeout=audio_cfg.handsfree.circuit_breaker_reset_timeout_seconds,
                silence_threshold=audio_cfg.handsfree.silence_threshold,
                clipping_threshold=audio_cfg.handsfree.clipping_threshold,
                tts_coordinator=tts_coordinator,  # Per-client TTS service manager
            )
            
            logger.info("✅ Audio processing services initialized (handsfree mode + wake word + Redis persistence enabled)")
            
    except ImportError as e:
        logger.warning("Audio processing services unavailable (missing dependencies): %s", e)
    except Exception as e:
        logger.error("Failed to initialize audio processing services: %s", e)
    
    audio_handler = AudioHandler(
        runtime=runtime,
        cache_service=cache_service,
        audio_processor=audio_processor,
        tts_coordinator=tts_coordinator,
    )
    
    context_handler = ContextHandler(
        runtime=runtime,
        history_service=history_service,
        cache_service=cache_service,
    )
    
    router = Router(
        runtime=runtime,
        message_handler=message_handler,
        control_handler=control_handler,
        audio_handler=audio_handler,
        context_handler=context_handler,
        task_manager=task_manager,
        request_mapper=request_mapper,
        cache_service=cache_service,
    )
    
    # Hub
    hub = WebSocketHub(
        router=router,
        cache_service=cache_service,
    )
    
    # Wire hub reference for audio processing callback AND router (for client state access)
    router._hub = hub  # Set hub reference on router for client state access
    
    if audio_processor:
        hub_ref['hub'] = hub
        hub_ref['message_handler'] = message_handler  # For handsfree-to-chat integration

    return hub

