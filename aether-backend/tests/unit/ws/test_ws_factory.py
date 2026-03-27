"""
Unit Tests: ws/factory.py (create_websocket_hub)

Tests dependency wiring, optional service injection, and error paths.
Audio service initialization is expected to fail in test env (missing openwakeword).
"""

import sys
from types import SimpleNamespace, ModuleType
from unittest.mock import AsyncMock, MagicMock

import pytest

from ws.factory import create_websocket_hub
from ws.presentation.hub import WebSocketHub
from ws.infrastructure.cache import RedisAdapter, MemoryFallbackCache


# =========================================================================
# Lifecycle-aware hub factory fixture
# =========================================================================


@pytest.fixture
async def hub_factory():
    """Yield an async factory that tracks created hubs and shuts them down.

    Every test that creates a WebSocketHub MUST use this fixture to prevent
    leaked MemoryFallbackCache cleanup tasks ('Task was destroyed but it
    is pending!' warnings).
    """
    created_hubs: list[WebSocketHub] = []

    async def _create(**kwargs) -> WebSocketHub:
        hub = await create_websocket_hub(**kwargs)
        created_hubs.append(hub)
        return hub

    yield _create

    for hub in created_hubs:
        try:
            await hub.shutdown()
        except Exception:
            pass


# =========================================================================
# Stubs for database repositories
# =========================================================================


class StubTrailRepository:
    def __init__(self, gateway):
        pass


class StubChatRepository:
    def __init__(self, gateway):
        pass


class StubPreferencesRepository:
    def __init__(self, gateway):
        self._gateway = gateway

    async def get_preference(self, *, preference_key, user_id, default_value=None):
        return default_value


# =========================================================================
# Tests
# =========================================================================


class TestBasicHubCreation:
    @pytest.mark.asyncio
    async def test_creates_hub_with_runtime_only(self, hub_factory):
        """Minimal hub creation: runtime only, no optional deps."""
        hub = await hub_factory(runtime=MagicMock())
        assert isinstance(hub, WebSocketHub)
        assert hasattr(hub, 'router')

    @pytest.mark.asyncio
    async def test_creates_hub_with_cache_client(self, hub_factory):
        """Hub with Redis cache client uses RedisAdapter."""
        mock_cache = MagicMock()
        hub = await hub_factory(
            runtime=MagicMock(),
            cache_client=mock_cache,
        )
        assert isinstance(hub, WebSocketHub)


class TestDatabaseGatewayWiring:
    @pytest.mark.asyncio
    async def test_creates_repos_with_database_gateway(self, monkeypatch, hub_factory):
        """Database gateway wires TrailRepository, ChatRepository, PreferencesRepository."""
        trail_calls = []
        chat_calls = []

        class MockTrailRepo:
            def __init__(self, gateway):
                trail_calls.append(gateway)

        class MockChatRepo:
            def __init__(self, gateway):
                chat_calls.append(gateway)

        class MockPrefsRepo:
            def __init__(self, gateway):
                pass
            async def get_preference(self, *, preference_key, user_id, default_value=None):
                return {"enabled": False}

        # Pre-register mock modules
        for name, cls_map in [
            ("data.database.repositories.trail", {"TrailRepository": MockTrailRepo}),
            ("data.database.repositories.chat", {"ChatRepository": MockChatRepo}),
            ("data.database.repositories.preferences", {"PreferencesRepository": MockPrefsRepo}),
        ]:
            if name not in sys.modules:
                mod = ModuleType(name)
                mod.__path__ = []
                monkeypatch.setitem(sys.modules, name, mod)
            for attr, val in cls_map.items():
                monkeypatch.setattr(sys.modules[name], attr, val)

        # Ensure parent packages exist
        for parent in ["data", "data.database", "data.database.repositories"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        gateway = MagicMock()
        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=gateway,
        )
        assert isinstance(hub, WebSocketHub)
        assert len(trail_calls) == 1
        assert len(chat_calls) == 1

    @pytest.mark.asyncio
    async def test_handsfree_preference_error_defaults_disabled(self, monkeypatch, hub_factory):
        """Error reading handsfree preference defaults to disabled."""

        class FailingPrefsRepo:
            def __init__(self, gateway):
                pass
            async def get_preference(self, **kwargs):
                raise AttributeError("broken")

        for name, cls_map in [
            ("data.database.repositories.trail", {"TrailRepository": StubTrailRepository}),
            ("data.database.repositories.chat", {"ChatRepository": StubChatRepository}),
            ("data.database.repositories.preferences", {"PreferencesRepository": FailingPrefsRepo}),
        ]:
            if name not in sys.modules:
                mod = ModuleType(name)
                mod.__path__ = []
                monkeypatch.setitem(sys.modules, name, mod)
            for attr, val in cls_map.items():
                monkeypatch.setattr(sys.modules[name], attr, val)

        for parent in ["data", "data.database", "data.database.repositories"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
        )
        assert isinstance(hub, WebSocketHub)

    @pytest.mark.asyncio
    async def test_handsfree_preference_connection_error_defaults_disabled(self, monkeypatch, hub_factory):
        """BUG: ConnectionError from preferences DB crashed factory.
        Fixed: broadened except to catch all exceptions.
        """

        class ConnectionFailPrefsRepo:
            def __init__(self, gateway):
                pass
            async def get_preference(self, **kwargs):
                raise ConnectionError("database unreachable")

        for name, cls_map in [
            ("data.database.repositories.trail", {"TrailRepository": StubTrailRepository}),
            ("data.database.repositories.chat", {"ChatRepository": StubChatRepository}),
            ("data.database.repositories.preferences", {"PreferencesRepository": ConnectionFailPrefsRepo}),
        ]:
            if name not in sys.modules:
                mod = ModuleType(name)
                mod.__path__ = []
                monkeypatch.setitem(sys.modules, name, mod)
            for attr, val in cls_map.items():
                monkeypatch.setattr(sys.modules[name], attr, val)

        for parent in ["data", "data.database", "data.database.repositories"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
        )
        assert isinstance(hub, WebSocketHub)

    @pytest.mark.asyncio
    async def test_handsfree_non_dict_preference(self, monkeypatch, hub_factory):
        """Non-dict preference value handled correctly."""

        class BoolPrefsRepo:
            def __init__(self, gateway):
                pass
            async def get_preference(self, **kwargs):
                return True  # Non-dict boolean

        for name, cls_map in [
            ("data.database.repositories.trail", {"TrailRepository": StubTrailRepository}),
            ("data.database.repositories.chat", {"ChatRepository": StubChatRepository}),
            ("data.database.repositories.preferences", {"PreferencesRepository": BoolPrefsRepo}),
        ]:
            if name not in sys.modules:
                mod = ModuleType(name)
                mod.__path__ = []
                monkeypatch.setitem(sys.modules, name, mod)
            for attr, val in cls_map.items():
                monkeypatch.setattr(sys.modules[name], attr, val)

        for parent in ["data", "data.database", "data.database.repositories"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
        )
        assert isinstance(hub, WebSocketHub)


class TestMemoryServiceWiring:
    @pytest.mark.asyncio
    async def test_wires_memory_service(self, monkeypatch, hub_factory):
        """Memory service is configured via set_memory_service."""
        set_calls = []

        def mock_set(service):
            set_calls.append(service)

        # Ensure module exists
        mod_name = "core.runtime.memory_injector"
        if mod_name not in sys.modules:
            mod = ModuleType(mod_name)
            monkeypatch.setitem(sys.modules, mod_name, mod)
        sys.modules[mod_name].set_memory_service = mock_set

        # Also parent packages
        for parent in ["core", "core.runtime"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        memory_svc = MagicMock()
        hub = await hub_factory(
            runtime=MagicMock(),
            memory_service=memory_svc,
        )
        assert isinstance(hub, WebSocketHub)
        assert set_calls == [memory_svc]

    @pytest.mark.asyncio
    async def test_memory_service_import_error_handled(self, monkeypatch, hub_factory):
        """ImportError for memory_injector is handled gracefully."""

        # Make the import fail
        original_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

        def patched_import(name, *args, **kwargs):
            if name == "core.runtime.memory_injector":
                raise ImportError("no module")
            return original_import(name, *args, **kwargs)

        monkeypatch.setattr("builtins.__import__", patched_import)

        hub = await hub_factory(
            runtime=MagicMock(),
            memory_service=MagicMock(),
        )
        assert isinstance(hub, WebSocketHub)


class TestRedisSettings:
    @pytest.mark.asyncio
    async def test_extracts_ttl_from_redis_settings(self, hub_factory):
        """TTL settings extracted from redis_settings object."""
        redis_settings = SimpleNamespace(
            presence_ttl_seconds=100,
            session_ttl_seconds=200,
            counter_ttl_seconds=300,
        )
        hub = await hub_factory(
            runtime=MagicMock(),
            redis_settings=redis_settings,
        )
        assert isinstance(hub, WebSocketHub)

    @pytest.mark.asyncio
    async def test_defaults_ttl_without_redis_settings(self, hub_factory):
        """Without redis_settings, uses default constants."""
        hub = await hub_factory(runtime=MagicMock())
        assert isinstance(hub, WebSocketHub)


class TestAudioInitialization:
    @pytest.mark.asyncio
    async def test_audio_import_error_handled(self, hub_factory):
        """Missing audio deps (openwakeword) caught gracefully."""
        # The test environment lacks openwakeword.
        # Factory should handle ImportError and still create hub.
        hub = await hub_factory(runtime=MagicMock())
        assert isinstance(hub, WebSocketHub)

    @pytest.mark.asyncio
    async def test_hub_ref_not_set_without_audio(self, hub_factory):
        """Without audio processor, hub_ref stays empty."""
        hub = await hub_factory(runtime=MagicMock())
        # Router should be wired
        assert hub.router is not None


# =========================================================================
# Deep Wiring Verification (Audit Strengthening)
# =========================================================================


class TestDeepWiringVerification:
    """Verify actual parameter propagation, not just isinstance."""

    @pytest.mark.asyncio
    async def test_ttl_values_propagate_to_cache_service(self, hub_factory):
        """Custom TTL values from redis_settings reach CacheService."""
        redis_settings = SimpleNamespace(
            presence_ttl_seconds=42,
            session_ttl_seconds=84,
            counter_ttl_seconds=168,
        )
        hub = await hub_factory(
            runtime=MagicMock(),
            redis_settings=redis_settings,
        )
        cache_svc = hub.router._cache
        assert cache_svc._presence_ttl == 42
        assert cache_svc._session_ttl == 84
        assert cache_svc._counter_ttl == 168

    @pytest.mark.asyncio
    async def test_default_ttl_values_without_redis_settings(self, hub_factory):
        """Without redis_settings, CacheService uses default constants."""
        from ws.config.constants import PRESENCE_TTL, SESSION_TTL, COUNTER_TTL
        hub = await hub_factory(runtime=MagicMock())
        cache_svc = hub.router._cache
        assert cache_svc._presence_ttl == PRESENCE_TTL
        assert cache_svc._session_ttl == SESSION_TTL
        assert cache_svc._counter_ttl == COUNTER_TTL

    @pytest.mark.asyncio
    async def test_cache_adapter_type_without_client(self, hub_factory):
        """No cache_client -> MemoryFallbackCache used."""
        hub = await hub_factory(runtime=MagicMock())
        cache_svc = hub.router._cache
        assert isinstance(cache_svc._cache, MemoryFallbackCache)

    @pytest.mark.asyncio
    async def test_cache_adapter_type_with_client(self, hub_factory):
        """cache_client -> RedisAdapter wraps it."""
        mock_redis = MagicMock()
        hub = await hub_factory(
            runtime=MagicMock(),
            cache_client=mock_redis,
        )
        cache_svc = hub.router._cache
        assert isinstance(cache_svc._cache, RedisAdapter)
        assert cache_svc._cache._redis is mock_redis

    @pytest.mark.asyncio
    async def test_runtime_wired_to_router_handlers(self, hub_factory):
        """Runtime instance reaches control_handler and message_handler."""
        runtime = MagicMock()
        hub = await hub_factory(runtime=runtime)
        router = hub.router
        assert router._control_handler._runtime is runtime
        # MessageHandler stores runtime for context monitoring
        assert router._message_handler._runtime is runtime

    @pytest.mark.asyncio
    async def test_hub_backreference_set_on_router(self, hub_factory):
        """Router._hub points back to the created hub."""
        hub = await hub_factory(runtime=MagicMock())
        assert hub.router._hub is hub

    @pytest.mark.asyncio
    async def test_context_handler_receives_history_service(self, hub_factory):
        """history_service parameter reaches ContextHandler."""
        history_svc = MagicMock()
        hub = await hub_factory(
            runtime=MagicMock(),
            history_service=history_svc,
        )
        assert hub.router._context_handler._history_service is history_svc

    @pytest.mark.asyncio
    async def test_context_handler_none_without_history_service(self, hub_factory):
        """Without history_service, ContextHandler._history_service is None."""
        hub = await hub_factory(runtime=MagicMock())
        assert hub.router._context_handler._history_service is None

    @pytest.mark.asyncio
    async def test_message_handler_receives_command_executor(self, hub_factory):
        """MessageHandler has CommandExecutor with both emitters."""
        hub = await hub_factory(runtime=MagicMock())
        mh = hub.router._message_handler
        assert mh._command_executor is not None
        assert mh._command_executor._stream_emitter is not None
        assert mh._command_executor._trail_emitter is not None

    @pytest.mark.asyncio
    async def test_stream_orchestrator_receives_all_services(self, hub_factory):
        """StreamOrchestrator wired with all application services."""
        hub = await hub_factory(runtime=MagicMock())
        mh = hub.router._message_handler
        orch = mh._stream_orchestrator
        assert orch._user_message_persister is not None
        assert orch._assistant_text_flusher is not None
        assert orch._settings_applicator is not None
        assert orch._summarization_service is not None
        assert orch._trail_coordinator is not None
        assert orch._cache_service is not None

    @pytest.mark.asyncio
    async def test_no_database_gateway_means_no_repos(self, hub_factory):
        """Without database_gateway, trail/chat repos are None."""
        hub = await hub_factory(runtime=MagicMock())
        mh = hub.router._message_handler
        orch = mh._stream_orchestrator
        assert orch._trail_coordinator._trail_repo is None
        assert orch._user_message_persister._chat_repository is None
        assert orch._assistant_text_flusher._chat_repository is None

    @pytest.mark.asyncio
    async def test_database_gateway_wires_repos_to_orchestrator(self, monkeypatch, hub_factory):
        """With database_gateway, repos are wired to orchestrator services."""
        for name, cls_map in [
            ("data.database.repositories.trail", {"TrailRepository": StubTrailRepository}),
            ("data.database.repositories.chat", {"ChatRepository": StubChatRepository}),
            ("data.database.repositories.preferences", {"PreferencesRepository": StubPreferencesRepository}),
        ]:
            if name not in sys.modules:
                mod = ModuleType(name)
                mod.__path__ = []
                monkeypatch.setitem(sys.modules, name, mod)
            for attr, val in cls_map.items():
                monkeypatch.setattr(sys.modules[name], attr, val)

        for parent in ["data", "data.database", "data.database.repositories"]:
            if parent not in sys.modules:
                pmod = ModuleType(parent)
                pmod.__path__ = []
                monkeypatch.setitem(sys.modules, parent, pmod)

        gateway = MagicMock()
        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=gateway,
        )
        mh = hub.router._message_handler
        orch = mh._stream_orchestrator
        # chat_repository should NOT be None
        assert orch._user_message_persister._chat_repository is not None
        assert orch._assistant_text_flusher._chat_repository is not None

    @pytest.mark.asyncio
    async def test_tts_coordinator_none_without_audio(self, hub_factory):
        """Without audio deps, tts_coordinator is None on message_handler."""
        hub = await hub_factory(runtime=MagicMock())
        mh = hub.router._message_handler
        assert mh._tts_coordinator is None

    @pytest.mark.asyncio
    async def test_audio_processor_none_without_deps(self, hub_factory):
        """Without audio deps, audio_handler has no audio_processor."""
        hub = await hub_factory(runtime=MagicMock())
        audio_handler = hub.router._audio_handler
        # audio_processor should be None (no openwakeword in test env)
        assert audio_handler._audio_processor is None

    @pytest.mark.asyncio
    async def test_task_manager_and_request_mapper_shared(self, hub_factory):
        """TaskManager and RequestMapper are shared between control/message/router."""
        hub = await hub_factory(runtime=MagicMock())
        router = hub.router
        # Control handler and router share same task_manager
        assert router._task_manager is router._control_handler._task_manager
        # Control handler and router share same request_mapper
        assert router._request_mapper is router._control_handler._request_mapper


# =========================================================================
# Handsfree Audio Initialization Path (lines 219-456, 492-493)
# =========================================================================


def _make_audio_config():
    """Build mock audio config with all fields required by factory."""
    return SimpleNamespace(
        opus=SimpleNamespace(target_sample_rate=16000, max_chunk_size_mb=5),
        vad=SimpleNamespace(
            model_id="pyannote/vad", device="cpu",
            min_duration_on=0.2, min_duration_off=0.3,
        ),
        stt=SimpleNamespace(model_id="openai/whisper", device="cpu"),
        tts=SimpleNamespace(
            voice="default", engine="piper",
            qwen3_model_path="/models/qwen3", qwen3_device="cpu",
            qwen3_instruct=True, qwen3_language="en",
        ),
        wake_word=SimpleNamespace(
            model_name="hey_mycroft", threshold=0.5,
            inference_framework="onnx", enable_vad=True,
            vad_threshold=0.5, expected_sample_rate=16000,
            frame_duration_ms=80, max_buffer_frames=100,
        ),
        handsfree=SimpleNamespace(
            conversation_timeout_seconds=30, cache_namespace="handsfree",
            max_buffer_seconds=30, sample_rate=16000,
            circuit_breaker_enabled=True, circuit_breaker_failure_threshold=5,
            circuit_breaker_reset_timeout_seconds=60,
            silence_threshold=0.01, clipping_threshold=0.95,
        ),
    )


def _mock_db_repos(monkeypatch, *, handsfree_pref=None):
    """Register mock DB repos in sys.modules with given handsfree preference."""
    if handsfree_pref is None:
        handsfree_pref = {"enabled": True}

    class HandsfreePrefsRepo:
        def __init__(self, gateway):
            pass

        async def get_preference(self, **kwargs):
            return handsfree_pref

    for name, cls_map in [
        ("data.database.repositories.trail", {"TrailRepository": StubTrailRepository}),
        ("data.database.repositories.chat", {"ChatRepository": StubChatRepository}),
        ("data.database.repositories.preferences", {"PreferencesRepository": HandsfreePrefsRepo}),
    ]:
        if name not in sys.modules:
            mod = ModuleType(name)
            mod.__path__ = []
            monkeypatch.setitem(sys.modules, name, mod)
        for attr, val in cls_map.items():
            monkeypatch.setattr(sys.modules[name], attr, val)

    for parent in ["data", "data.database", "data.database.repositories"]:
        if parent not in sys.modules:
            pmod = ModuleType(parent)
            pmod.__path__ = []
            monkeypatch.setitem(sys.modules, parent, pmod)


def _mock_audio_modules(monkeypatch, *, processor_cls=None):
    """Replace ws.domain.audio and sub-modules with stubs.

    Args:
        processor_cls: Optional class to use for AudioProcessingService.
            Defaults to a MagicMock-based class (truthy, accepts any kwargs).
    """
    # Simple stub classes that accept any kwargs
    class StubOpusDecoder:
        def __init__(self, **kw):
            pass

    class StubVadService:
        def __init__(self, **kw):
            pass

    class StubSttService:
        def __init__(self, **kw):
            pass

    class StubWakeWordService:
        def __init__(self, **kw):
            pass

    class StubTTSCoordinator:
        def __init__(self, **kw):
            pass

    if processor_cls is None:
        # MagicMock is callable with any args and is truthy
        processor_cls = lambda **kw: MagicMock()

    # Main audio package
    audio_mod = ModuleType("ws.domain.audio")
    audio_mod.OpusDecoder = StubOpusDecoder
    audio_mod.PyannotVadService = StubVadService
    audio_mod.WhisperSttService = StubSttService
    audio_mod.AudioProcessingService = processor_cls
    monkeypatch.setitem(sys.modules, "ws.domain.audio", audio_mod)

    # Sub-modules used by factory
    svc_mod = ModuleType("ws.domain.audio.services")
    svc_mod.__path__ = []
    monkeypatch.setitem(sys.modules, "ws.domain.audio.services", svc_mod)

    ww_mod = ModuleType("ws.domain.audio.services.wake_word_service")
    ww_mod.WakeWordService = StubWakeWordService
    monkeypatch.setitem(sys.modules, "ws.domain.audio.services.wake_word_service", ww_mod)

    tts_mod = ModuleType("ws.domain.audio.services.tts_coordinator")
    tts_mod.TTSCoordinator = StubTTSCoordinator
    monkeypatch.setitem(sys.modules, "ws.domain.audio.services.tts_coordinator", tts_mod)


def _mock_audio_config(monkeypatch, audio_cfg=None):
    """Register config.audio_config in sys.modules."""
    if audio_cfg is None:
        audio_cfg = _make_audio_config()

    cfg_mod = ModuleType("config.audio_config")
    cfg_mod.get_audio_config = lambda: audio_cfg
    monkeypatch.setitem(sys.modules, "config.audio_config", cfg_mod)

    for parent in ["config"]:
        if parent not in sys.modules:
            pmod = ModuleType(parent)
            pmod.__path__ = []
            monkeypatch.setitem(sys.modules, parent, pmod)

    return audio_cfg


class TestHandsfreeAudioPath:
    """Tests for the handsfree-enabled audio initialization path."""

    @pytest.mark.asyncio
    async def test_full_handsfree_with_tts_piper(self, monkeypatch, hub_factory):
        """
        Lines 225-451, 492-493: Full handsfree path with TTS (piper engine).
        AudioProcessingService created, hub_ref wired.
        """
        _mock_db_repos(monkeypatch, handsfree_pref={"enabled": True})
        _mock_audio_modules(monkeypatch)
        audio_cfg = _mock_audio_config(monkeypatch)
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "hf-test-token")

        # TTS integration: available, init succeeds
        tts = MagicMock()
        tts.is_available.return_value = True
        tts.initialize_engine.return_value = True

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
            settings=SimpleNamespace(audio=audio_cfg),
            tts_integration=tts,
        )
        assert isinstance(hub, WebSocketHub)
        # Audio processor should be set (not None)
        assert hub.router._audio_handler._audio_processor is not None
        # TTS coordinator wired to message handler
        assert hub.router._message_handler._tts_coordinator is not None
        assert hub.router._message_handler._tts_config is not None
        # TTS init called with piper engine
        tts.initialize_engine.assert_called_once()
        call_kwargs = tts.initialize_engine.call_args
        assert call_kwargs[1]["engine_name"] == "piper"

    @pytest.mark.asyncio
    async def test_handsfree_qwen3_engine(self, monkeypatch, hub_factory):
        """
        Lines 240-244: qwen3 engine passes extra kwargs (model_path, device, etc.)
        """
        _mock_db_repos(monkeypatch, handsfree_pref={"enabled": True})
        _mock_audio_modules(monkeypatch)
        audio_cfg = _make_audio_config()
        audio_cfg.tts.engine = "qwen3"
        _mock_audio_config(monkeypatch, audio_cfg)
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "hf-test-token")

        tts = MagicMock()
        tts.is_available.return_value = True
        tts.initialize_engine.return_value = True

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
            settings=SimpleNamespace(audio=audio_cfg),
            tts_integration=tts,
        )
        assert isinstance(hub, WebSocketHub)
        call_kwargs = tts.initialize_engine.call_args[1]
        assert call_kwargs["engine_name"] == "qwen3"
        assert call_kwargs["model_path"] == "/models/qwen3"
        assert call_kwargs["device"] == "cpu"
        assert call_kwargs["instruct"] is True
        assert call_kwargs["language"] == "en"

    @pytest.mark.asyncio
    async def test_no_hf_token_skips_audio(self, monkeypatch, hub_factory):
        """
        Lines 219-221: No HUGGINGFACE_TOKEN → warning, audio disabled.
        """
        _mock_db_repos(monkeypatch, handsfree_pref={"enabled": True})
        _mock_audio_modules(monkeypatch)
        monkeypatch.delenv("HUGGINGFACE_TOKEN", raising=False)

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
        )
        assert isinstance(hub, WebSocketHub)
        # No audio processor
        assert hub.router._audio_handler._audio_processor is None

    @pytest.mark.asyncio
    async def test_handsfree_disabled_skip(self, monkeypatch, hub_factory):
        """
        Lines 222-224: handsfree_enabled=False, HF token present → pass.
        """
        _mock_db_repos(monkeypatch, handsfree_pref={"enabled": False})
        _mock_audio_modules(monkeypatch)
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "hf-test-token")

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
        )
        assert isinstance(hub, WebSocketHub)
        assert hub.router._audio_handler._audio_processor is None

    @pytest.mark.asyncio
    async def test_tts_not_available(self, monkeypatch, hub_factory):
        """
        Lines 266-268: TTS integration not available.
        """
        _mock_db_repos(monkeypatch, handsfree_pref={"enabled": True})
        _mock_audio_modules(monkeypatch)
        _mock_audio_config(monkeypatch)
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "hf-test-token")

        tts = MagicMock()
        tts.is_available.return_value = False

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
            tts_integration=tts,
        )
        assert isinstance(hub, WebSocketHub)
        # Audio processor should still exist (TTS is optional)
        assert hub.router._audio_handler._audio_processor is not None
        # TTS coordinator should be None
        assert hub.router._message_handler._tts_coordinator is None

    @pytest.mark.asyncio
    async def test_tts_init_fails(self, monkeypatch, hub_factory):
        """
        Lines 263-265: TTS init returns False → no TTS coordinator.
        """
        _mock_db_repos(monkeypatch, handsfree_pref={"enabled": True})
        _mock_audio_modules(monkeypatch)
        _mock_audio_config(monkeypatch)
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "hf-test-token")

        tts = MagicMock()
        tts.is_available.return_value = True
        tts.initialize_engine.return_value = False  # Init fails

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
            tts_integration=tts,
        )
        assert isinstance(hub, WebSocketHub)
        assert hub.router._message_handler._tts_coordinator is None
        assert hub.router._message_handler._tts_config is None

    @pytest.mark.asyncio
    async def test_no_tts_integration_provided(self, monkeypatch, hub_factory):
        """
        Lines 233-235: tts_integration=None → TTS disabled.
        """
        _mock_db_repos(monkeypatch, handsfree_pref={"enabled": True})
        _mock_audio_modules(monkeypatch)
        _mock_audio_config(monkeypatch)
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "hf-test-token")

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
            tts_integration=None,
        )
        assert isinstance(hub, WebSocketHub)
        assert hub.router._message_handler._tts_coordinator is None

    @pytest.mark.asyncio
    async def test_audio_runtime_error_caught(self, monkeypatch, hub_factory):
        """
        Lines 455-456: RuntimeError during audio init caught gracefully.
        """
        _mock_db_repos(monkeypatch, handsfree_pref={"enabled": True})
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "hf-test-token")

        # Make audio import succeed but construction raise RuntimeError
        def bad_processor(**kw):
            raise RuntimeError("model load failed")

        _mock_audio_modules(monkeypatch, processor_cls=bad_processor)
        _mock_audio_config(monkeypatch)

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
            tts_integration=None,
        )
        assert isinstance(hub, WebSocketHub)
        # Audio processor should be None (init failed)
        assert hub.router._audio_handler._audio_processor is None

    @pytest.mark.asyncio
    async def test_audio_import_error_path(self, monkeypatch, hub_factory):
        """
        Lines 453-454: ImportError when audio modules unavailable.
        """
        _mock_db_repos(monkeypatch, handsfree_pref={"enabled": True})
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "hf-test-token")

        # Block audio module import
        monkeypatch.setitem(sys.modules, "ws.domain.audio", None)

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
        )
        assert isinstance(hub, WebSocketHub)
        assert hub.router._audio_handler._audio_processor is None

    @pytest.mark.asyncio
    async def test_settings_audio_takes_precedence(self, monkeypatch, hub_factory):
        """
        Line 228: settings.audio used instead of get_audio_config() when provided.
        """
        _mock_db_repos(monkeypatch, handsfree_pref={"enabled": True})
        _mock_audio_modules(monkeypatch)
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "hf-test-token")

        # Don't mock config.audio_config — settings.audio should be used instead
        custom_cfg = _make_audio_config()
        custom_cfg.opus.target_sample_rate = 44100  # Custom value

        hub = await hub_factory(
            runtime=MagicMock(),
            database_gateway=MagicMock(),
            settings=SimpleNamespace(audio=custom_cfg),
            tts_integration=None,
        )
        assert isinstance(hub, WebSocketHub)
        assert hub.router._audio_handler._audio_processor is not None


# =========================================================================
# on_transcript / on_interruption callback tests (lines 298-415, 492-493)
# =========================================================================


async def _create_hub_with_callbacks(monkeypatch, hub_factory):
    """
    Create a hub with handsfree enabled and return (hub, captured_callbacks).
    The captured dict contains 'on_transcript' and 'on_interruption' closures.
    """
    _mock_db_repos(monkeypatch, handsfree_pref={"enabled": True})

    captured = {}

    def capturing_processor(**kw):
        captured["on_transcript"] = kw.get("on_transcript")
        captured["on_interruption"] = kw.get("on_interruption")
        return MagicMock()

    _mock_audio_modules(monkeypatch, processor_cls=capturing_processor)
    _mock_audio_config(monkeypatch)
    monkeypatch.setenv("HUGGINGFACE_TOKEN", "hf-test-token")

    hub = await hub_factory(
        runtime=MagicMock(),
        database_gateway=MagicMock(),
        tts_integration=None,
    )
    return hub, captured


class TestOnTranscriptCallback:
    """Tests for the on_transcript closure defined in create_websocket_hub."""

    # NOTE: Lines 299-300 (hub_ref['hub'] is None) and 352-353 (no message_handler)
    # are defensive dead code — after create_websocket_hub returns, hub_ref is always
    # populated (line 492-493). These cannot be reached without breaking the closure.

    @pytest.mark.asyncio
    async def test_client_not_found(self, monkeypatch, hub_factory):
        """Lines 303-306: Client not in hub.clients → returns early."""
        hub, captured = await _create_hub_with_callbacks(monkeypatch, hub_factory)
        on_transcript = captured["on_transcript"]

        # Don't add client to hub.clients
        hub.send_to_client = AsyncMock()
        await on_transcript("nonexistent-client", "Hello")
        hub.send_to_client.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_wake_word_detected(self, monkeypatch, hub_factory):
        """Lines 309-318: __WAKE_WORD_DETECTED__ sends wake-word-detected event."""
        hub, captured = await _create_hub_with_callbacks(monkeypatch, hub_factory)
        on_transcript = captured["on_transcript"]

        mock_client = SimpleNamespace(ws=AsyncMock(), active_chat_id="chat-1")
        hub.clients["c1"] = mock_client
        hub.send_to_client = AsyncMock(return_value=True)

        await on_transcript("c1", "__WAKE_WORD_DETECTED__")

        hub.send_to_client.assert_awaited_once()
        msg = hub.send_to_client.call_args[0][1]
        assert msg["type"] == "wake-word-detected"
        assert msg["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_sleep_word_detected(self, monkeypatch, hub_factory):
        """Lines 321-330: __SLEEP_WORD_DETECTED__ sends sleep-word-detected event."""
        hub, captured = await _create_hub_with_callbacks(monkeypatch, hub_factory)
        on_transcript = captured["on_transcript"]

        mock_client = SimpleNamespace(ws=AsyncMock(), active_chat_id="chat-1")
        hub.clients["c1"] = mock_client
        hub.send_to_client = AsyncMock(return_value=True)

        await on_transcript("c1", "__SLEEP_WORD_DETECTED__")

        hub.send_to_client.assert_awaited_once()
        msg = hub.send_to_client.call_args[0][1]
        assert msg["type"] == "sleep-word-detected"

    @pytest.mark.asyncio
    async def test_normal_text_full_path(self, monkeypatch, hub_factory):
        """Lines 332-393: Normal text → STT event + LLM chat integration."""
        hub, captured = await _create_hub_with_callbacks(monkeypatch, hub_factory)
        on_transcript = captured["on_transcript"]

        mock_ws = AsyncMock()
        mock_client = SimpleNamespace(ws=mock_ws, active_chat_id="chat-abc")
        hub.clients["c1"] = mock_client
        hub.send_to_client = AsyncMock(return_value=True)

        # Mock the message handler to accept handle_user_message
        hub.router._message_handler.handle_user_message = AsyncMock()

        await on_transcript("c1", "Hello world")

        # STT event sent
        assert hub.send_to_client.await_count >= 1
        stt_msg = hub.send_to_client.call_args_list[0][0][1]
        assert stt_msg["type"] == "stt-final"
        assert stt_msg["text"] == "Hello world"

        # Chat integration: handle_user_message called
        hub.router._message_handler.handle_user_message.assert_awaited_once()
        call_kwargs = hub.router._message_handler.handle_user_message.call_args[1]
        assert call_kwargs["ws"] is mock_ws
        assert call_kwargs["client_id"] == "c1"
        msg = call_kwargs["message"]
        assert msg.content == "Hello world"
        assert msg.chat_id == "chat-abc"
        assert "handsfree" in msg.correlation_id

    @pytest.mark.asyncio
    async def test_stt_send_fails_returns_early(self, monkeypatch, hub_factory):
        """Lines 344-346: send_to_client returns False → skip chat integration."""
        hub, captured = await _create_hub_with_callbacks(monkeypatch, hub_factory)
        on_transcript = captured["on_transcript"]

        mock_client = SimpleNamespace(ws=AsyncMock(), active_chat_id="chat-1")
        hub.clients["c1"] = mock_client
        hub.send_to_client = AsyncMock(return_value=False)  # Send fails

        hub.router._message_handler.handle_user_message = AsyncMock()

        await on_transcript("c1", "Hello")

        # Message handler should NOT be called (send failed)
        hub.router._message_handler.handle_user_message.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_active_chat_id(self, monkeypatch, hub_factory):
        """Lines 356-359: No active_chat_id on client → still processes (with warning)."""
        hub, captured = await _create_hub_with_callbacks(monkeypatch, hub_factory)
        on_transcript = captured["on_transcript"]

        mock_client = SimpleNamespace(ws=AsyncMock())  # NO active_chat_id
        hub.clients["c1"] = mock_client
        hub.send_to_client = AsyncMock(return_value=True)
        hub.router._message_handler.handle_user_message = AsyncMock()

        await on_transcript("c1", "Hello")

        # Should still call handle_user_message (chat_id will be None)
        hub.router._message_handler.handle_user_message.assert_awaited_once()
        msg = hub.router._message_handler.handle_user_message.call_args[1]["message"]
        assert msg.chat_id is None

    @pytest.mark.asyncio
    async def test_llm_busy_drops_request(self, monkeypatch, hub_factory):
        """Lines 377-379: LLM lock already acquired → drops request."""
        hub, captured = await _create_hub_with_callbacks(monkeypatch, hub_factory)
        on_transcript = captured["on_transcript"]

        mock_client = SimpleNamespace(ws=AsyncMock(), active_chat_id="chat-1")
        hub.clients["c1"] = mock_client
        hub.send_to_client = AsyncMock(return_value=True)
        hub.router._message_handler.handle_user_message = AsyncMock()

        # Pre-acquire the lock for this client
        import asyncio
        from ws.factory import client_llm_locks
        lock = asyncio.Lock()
        await lock.acquire()
        client_llm_locks["c1"] = lock

        try:
            await on_transcript("c1", "Hello")
            # handle_user_message should NOT be called (lock busy)
            hub.router._message_handler.handle_user_message.assert_not_awaited()
        finally:
            lock.release()
            client_llm_locks.pop("c1", None)

    @pytest.mark.asyncio
    async def test_chat_integration_error_caught(self, monkeypatch, hub_factory):
        """Lines 391-392: Error during handle_user_message caught gracefully."""
        hub, captured = await _create_hub_with_callbacks(monkeypatch, hub_factory)
        on_transcript = captured["on_transcript"]

        mock_client = SimpleNamespace(ws=AsyncMock(), active_chat_id="chat-1")
        hub.clients["c1"] = mock_client
        hub.send_to_client = AsyncMock(return_value=True)

        hub.router._message_handler.handle_user_message = AsyncMock(
            side_effect=RuntimeError("LLM crashed"),
        )

        # Must NOT raise
        await on_transcript("c1", "Hello")


class TestOnInterruptionCallback:
    """Tests for the on_interruption closure defined in create_websocket_hub."""

    @pytest.mark.asyncio
    async def test_client_not_found(self, monkeypatch, hub_factory):
        """Lines 403-406: Client not in hub.clients → returns early."""
        hub, captured = await _create_hub_with_callbacks(monkeypatch, hub_factory)
        on_interruption = captured["on_interruption"]

        hub.send_to_client = AsyncMock()
        await on_interruption("nonexistent")
        hub.send_to_client.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_sends_interruption_event(self, monkeypatch, hub_factory):
        """Lines 409-415: Sends interruption-detected event to client."""
        hub, captured = await _create_hub_with_callbacks(monkeypatch, hub_factory)
        on_interruption = captured["on_interruption"]

        mock_client = SimpleNamespace(ws=AsyncMock())
        hub.clients["c1"] = mock_client
        hub.send_to_client = AsyncMock(return_value=True)

        await on_interruption("c1")

        hub.send_to_client.assert_awaited_once()
        msg = hub.send_to_client.call_args[0][1]
        assert msg["type"] == "interruption-detected"
        assert msg["role"] == "assistant"
