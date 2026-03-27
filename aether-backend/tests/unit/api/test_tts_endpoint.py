"""
Unit tests for TTS endpoint (api/v1/endpoints/tts.py).

6 routes:
  GET  /v1/tts/engines
  POST /v1/tts/synthesize
  POST /v1/tts/stream
  POST /v1/tts/preview
  GET  /v1/tts/health
  POST /v1/tts/initialize

CI: pytest tests/unit/api/test_tts_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


def _mock_tts(available=True, current_engine="system", engines=None):
    """Build a mock TTSIntegration."""
    tts = MagicMock()
    tts.is_available.return_value = available
    tts.get_current_engine.return_value = current_engine
    tts.get_available_engines.return_value = engines or ["system", "qwen3", "kokoro"]
    tts.initialize_engine.return_value = True
    tts.synthesize_text_async = AsyncMock(return_value=b"\x00\x01" * 100)
    tts.check_health = AsyncMock(return_value={
        "healthy": True,
        "message": "TTS operational",
        "current_engine": current_engine,
        "available_engines": engines or ["system", "qwen3", "kokoro"],
    })
    # _direct_engine mock
    engine = MagicMock()
    engine.current_voice = "Ryan"
    engine.current_language = "english"
    engine.instruct = None
    engine._sample_rate = 24000
    tts._direct_engine = engine
    return tts


TTS_PATCH = "api.v1.endpoints.tts.get_tts_integration"
AUDIO_CFG_PATCH = "config.audio_config.get_audio_config"


def _mock_audio_config():
    """Build a mock AudioConfig for qwen3-specific code paths."""
    cfg = MagicMock()
    cfg.tts.qwen3_model_path = "/models/qwen3-tts"
    cfg.tts.qwen3_device = "cpu"
    cfg.tts.qwen3_instruct = "Speak naturally."
    cfg.tts.qwen3_language = "english"
    return cfg


class _RestoreFailEngine:
    """Engine mock where state restore raises for voice, language, and instruct.

    Verifies that exceptions during engine state restoration in the finally
    block are silently swallowed and do not mask the synthesis result.

    Args:
        instruct_fail_on: Which set-call number triggers instruct failure.
            2 for synthesize (first set is config override, second is restore).
            1 for preview (no config override, first set IS the restore).
    """

    def __init__(self, instruct_fail_on=2):
        self.current_voice = "Ryan"
        self._language = "english"
        self._instruct = "original"
        self._sample_rate = 24000
        self._voice_calls = 0
        self._instruct_sets = 0
        self._instruct_fail_on = instruct_fail_on

    def set_voice(self, voice):
        self._voice_calls += 1
        if self._voice_calls >= 2:
            raise RuntimeError("voice restore fail")

    @property
    def current_language(self):
        return self._language

    @current_language.setter
    def current_language(self, value):
        raise RuntimeError("language restore fail")

    @property
    def instruct(self):
        return self._instruct

    @instruct.setter
    def instruct(self, value):
        self._instruct_sets += 1
        if self._instruct_sets >= self._instruct_fail_on:
            raise RuntimeError("instruct restore fail")
        self._instruct = value

    def set_voice_parameters(self, **kwargs):
        pass


# ===========================================================================
# GET /tts/engines
# ===========================================================================

class TestListEngines:

    @pytest.mark.asyncio
    async def test_engines_success(self, client):
        """Returns available engines with current engine and availability."""
        with patch(TTS_PATCH, return_value=_mock_tts()):
            resp = await client.get("/v1/tts/engines")
        assert resp.status_code == 200
        body = resp.json()
        assert body["available"] is True
        assert body["current_engine"] == "system"
        assert "system" in body["engines"]

    @pytest.mark.asyncio
    async def test_engines_unavailable(self, client):
        """When TTS unavailable, returns empty engines list."""
        with patch(TTS_PATCH, return_value=_mock_tts(available=False)):
            resp = await client.get("/v1/tts/engines")
        assert resp.status_code == 200
        body = resp.json()
        assert body["available"] is False
        assert body["engines"] == []

    @pytest.mark.asyncio
    async def test_engines_error_returns_500(self, client):
        """get_tts_integration error returns 500."""
        with patch(TTS_PATCH, side_effect=RuntimeError("init fail")):
            resp = await client.get("/v1/tts/engines")
        assert resp.status_code == 500
        assert "Failed to list engines" in resp.json()["detail"]


# ===========================================================================
# POST /tts/synthesize
# ===========================================================================

class TestSynthesize:

    @pytest.mark.asyncio
    async def test_synthesize_missing_text_returns_422(self, client):
        """Missing text field returns 422."""
        resp = await client.post("/v1/tts/synthesize", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_synthesize_empty_text_returns_422(self, client):
        """Empty text returns 422 (min_length=1)."""
        resp = await client.post("/v1/tts/synthesize", json={"text": ""})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_synthesize_success_returns_wav(self, client):
        """Valid synthesis returns audio/wav response."""
        tts = _mock_tts()
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/synthesize",
                json={"text": "Hello world", "engine": "system"},
            )
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/wav"
        # WAV header starts with RIFF
        assert resp.content[:4] == b"RIFF"

    @pytest.mark.asyncio
    async def test_synthesize_unavailable_returns_503(self, client):
        """TTS unavailable returns 503."""
        with patch(TTS_PATCH, return_value=_mock_tts(available=False)):
            resp = await client.post(
                "/v1/tts/synthesize", json={"text": "Hello"}
            )
        assert resp.status_code == 503
        assert "TTS service not available" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_synthesize_null_audio_returns_500(self, client):
        """Synthesis returning None returns 500."""
        tts = _mock_tts()
        tts.synthesize_text_async = AsyncMock(return_value=None)
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/synthesize",
                json={"text": "Hello", "engine": "system"},
            )
        assert resp.status_code == 500
        assert "Synthesis failed" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_synthesize_engine_init_failure_returns_400(self, client):
        """Engine init failure returns 400."""
        tts = _mock_tts(current_engine="system")
        tts.initialize_engine.return_value = False
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/synthesize",
                json={"text": "Hello", "engine": "kokoro"},
            )
        assert resp.status_code == 400
        assert "Failed to initialize" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_synthesize_qwen3_engine_switch_full_kwargs(self, client):
        """Switching to qwen3 loads audio config and passes all kwargs."""
        tts = _mock_tts(current_engine="system")
        audio_cfg = _mock_audio_config()
        with patch(TTS_PATCH, return_value=tts), \
             patch(AUDIO_CFG_PATCH, return_value=audio_cfg):
            resp = await client.post(
                "/v1/tts/synthesize",
                json={
                    "text": "Hello",
                    "engine": "qwen3",
                    "voice": "Ryan",
                    "language": "chinese",
                    "api_key": "sk-test-key",
                },
            )
        assert resp.status_code == 200
        assert resp.content[:4] == b"RIFF"
        tts.initialize_engine.assert_called_once()
        args, kw = tts.initialize_engine.call_args
        assert args == ("qwen3",)
        assert kw["voice"] == "Ryan"
        assert kw["model_path"] == "/models/qwen3-tts"
        assert kw["device"] == "cpu"
        assert kw["instruct"] == "Speak naturally."
        assert kw["language"] == "chinese"
        assert kw["api_key"] == "sk-test-key"

    @pytest.mark.asyncio
    async def test_synthesize_voice_and_language_overrides(self, client):
        """Voice and language request fields are applied to the engine."""
        tts = _mock_tts(current_engine="system")
        engine = tts._direct_engine
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/synthesize",
                json={"text": "Hello", "engine": "system", "voice": "Vivian", "language": "chinese"},
            )
        assert resp.status_code == 200
        engine.set_voice.assert_any_call("Vivian")
        engine.set_voice_parameters.assert_called_once_with(language="chinese")

    @pytest.mark.asyncio
    async def test_synthesize_qwen3_instruct_applied_and_restored(self, client):
        """Qwen3 instruct override applied from config; original restored in finally."""
        tts = _mock_tts(current_engine="qwen3")
        engine = tts._direct_engine
        engine.instruct = "old instruct"
        audio_cfg = _mock_audio_config()
        with patch(TTS_PATCH, return_value=tts), \
             patch(AUDIO_CFG_PATCH, return_value=audio_cfg):
            resp = await client.post(
                "/v1/tts/synthesize",
                json={"text": "Hello", "engine": "qwen3"},
            )
        assert resp.status_code == 200
        assert resp.content[:4] == b"RIFF"
        # After synthesis, engine.instruct restored to original value
        assert engine.instruct == "old instruct"

    @pytest.mark.asyncio
    async def test_synthesize_all_restore_exceptions_swallowed(self, client):
        """Exceptions during voice/language/instruct restore are silently swallowed."""
        tts = _mock_tts(current_engine="qwen3")
        tts._direct_engine = _RestoreFailEngine(instruct_fail_on=2)
        audio_cfg = _mock_audio_config()
        with patch(TTS_PATCH, return_value=tts), \
             patch(AUDIO_CFG_PATCH, return_value=audio_cfg):
            resp = await client.post(
                "/v1/tts/synthesize",
                json={"text": "Hello", "engine": "qwen3", "voice": "Ryan", "language": "chinese"},
            )
        assert resp.status_code == 200
        assert resp.content[:4] == b"RIFF"

    @pytest.mark.asyncio
    async def test_synthesize_unexpected_exception_returns_500(self, client):
        """Non-HTTP exception during synthesis returns 500."""
        tts = _mock_tts(current_engine="system")
        tts.synthesize_text_async = AsyncMock(side_effect=RuntimeError("unexpected"))
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/synthesize",
                json={"text": "Hello", "engine": "system"},
            )
        assert resp.status_code == 500
        assert "Synthesis failed" in resp.json()["detail"]


# ===========================================================================
# POST /tts/stream
# ===========================================================================

class TestStream:

    @pytest.mark.asyncio
    async def test_stream_missing_text_returns_422(self, client):
        """Missing text returns 422."""
        resp = await client.post("/v1/tts/stream", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_stream_unavailable_returns_503(self, client):
        """TTS unavailable returns 503."""
        with patch(TTS_PATCH, return_value=_mock_tts(available=False)):
            resp = await client.post("/v1/tts/stream", json={"text": "Hello"})
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_stream_success_returns_audio(self, client):
        """Valid stream returns audio/wav streaming response."""
        tts = _mock_tts()

        async def _fake_stream(text):
            yield b"\x00\x01" * 50
            yield b"\x00\x02" * 50

        tts.stream_synthesis = _fake_stream

        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/stream",
                json={"text": "Hello world", "engine": "system"},
            )
        assert resp.status_code == 200
        assert "audio/wav" in resp.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_stream_engine_init_failure_returns_400(self, client):
        """Engine init failure returns 400."""
        tts = _mock_tts(current_engine="system")
        tts.initialize_engine.return_value = False
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/stream", json={"text": "Hello", "engine": "kokoro"}
            )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_stream_generic_exception_returns_500(self, client):
        """Non-HTTP exception in stream_speech returns 500."""
        with patch(TTS_PATCH, side_effect=RuntimeError("crash")):
            resp = await client.post("/v1/tts/stream", json={"text": "Hello"})
        assert resp.status_code == 500
        assert "Streaming failed" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_stream_generator_error_logged(self, client):
        """Exception during stream iteration is caught and logged."""
        tts = _mock_tts()
        err = RuntimeError("stream boom")

        async def _failing_stream(text):
            raise err
            yield b""  # noqa: unreachable — required for async generator

        tts.stream_synthesis = _failing_stream
        with patch(TTS_PATCH, return_value=tts), \
             patch("api.v1.endpoints.tts.logger") as mock_logger:
            try:
                await client.post(
                    "/v1/tts/stream",
                    json={"text": "Hello", "engine": "system"},
                )
            except Exception:
                pass
            mock_logger.error.assert_any_call("Streaming error: %s", err)


# ===========================================================================
# POST /tts/preview
# ===========================================================================

class TestPreview:

    @pytest.mark.asyncio
    async def test_preview_success_returns_wav(self, client):
        """Preview returns audio/wav for valid voice."""
        # current_engine matches request engine, so init block is skipped
        tts = _mock_tts(current_engine="system")
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/preview",
                json={"engine": "system", "voice": "Ryan"},
            )
        assert resp.status_code == 200
        assert resp.content[:4] == b"RIFF"

    @pytest.mark.asyncio
    async def test_preview_unavailable_returns_503(self, client):
        """TTS unavailable returns 503."""
        with patch(TTS_PATCH, return_value=_mock_tts(available=False)):
            resp = await client.post(
                "/v1/tts/preview", json={"engine": "system", "voice": "Ryan"}
            )
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_preview_null_audio_returns_500(self, client):
        """Synthesis returning None returns 500."""
        tts = _mock_tts(current_engine="system")
        tts.synthesize_text_async = AsyncMock(return_value=None)
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/preview", json={"engine": "system", "voice": "Ryan"}
            )
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_preview_qwen3_loads_audio_config(self, client):
        """Preview with qwen3 engine loads audio config kwargs."""
        tts = _mock_tts(current_engine="system")
        audio_cfg = _mock_audio_config()
        with patch(TTS_PATCH, return_value=tts), \
             patch(AUDIO_CFG_PATCH, return_value=audio_cfg):
            resp = await client.post(
                "/v1/tts/preview",
                json={"engine": "qwen3", "voice": "Ryan"},
            )
        assert resp.status_code == 200
        assert resp.content[:4] == b"RIFF"
        tts.initialize_engine.assert_called_once()
        args, kw = tts.initialize_engine.call_args
        assert args == ("qwen3",)
        assert kw["voice"] == "Ryan"
        assert kw["model_path"] == "/models/qwen3-tts"
        assert kw["device"] == "cpu"
        assert kw["instruct"] == "Speak naturally."
        assert kw["language"] == "english"

    @pytest.mark.asyncio
    async def test_preview_engine_init_failure_returns_400(self, client):
        """Preview engine init failure returns 400."""
        tts = _mock_tts(current_engine="system")
        tts.initialize_engine.return_value = False
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/preview",
                json={"engine": "kokoro", "voice": "Ryan"},
            )
        assert resp.status_code == 400
        assert "Failed to initialize" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_preview_all_restore_exceptions_swallowed(self, client):
        """Exceptions during voice/language/instruct restore in preview are swallowed."""
        tts = _mock_tts(current_engine="system")
        tts._direct_engine = _RestoreFailEngine(instruct_fail_on=1)
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/preview",
                json={"engine": "system", "voice": "Ryan"},
            )
        assert resp.status_code == 200
        assert resp.content[:4] == b"RIFF"

    @pytest.mark.asyncio
    async def test_preview_generic_exception_returns_500(self, client):
        """Non-HTTP exception during preview returns 500."""
        with patch(TTS_PATCH, side_effect=RuntimeError("crash")):
            resp = await client.post(
                "/v1/tts/preview",
                json={"engine": "system", "voice": "Ryan"},
            )
        assert resp.status_code == 500
        assert "Voice preview failed" in resp.json()["detail"]


# ===========================================================================
# GET /tts/health
# ===========================================================================

class TestHealth:

    @pytest.mark.asyncio
    async def test_health_healthy(self, client):
        """Returns healthy status when TTS operational."""
        with patch(TTS_PATCH, return_value=_mock_tts()):
            resp = await client.get("/v1/tts/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is True
        assert body["message"] == "TTS operational"
        assert body["current_engine"] == "system"
        assert len(body["available_engines"]) > 0

    @pytest.mark.asyncio
    async def test_health_error_returns_unhealthy(self, client):
        """Error during health check returns unhealthy (not 500)."""
        with patch(TTS_PATCH, side_effect=RuntimeError("tts broken")):
            resp = await client.get("/v1/tts/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is False
        assert body["available_engines"] == []


# ===========================================================================
# POST /tts/initialize
# ===========================================================================

class TestInitialize:

    @pytest.mark.asyncio
    async def test_initialize_success(self, client):
        """Successful engine init returns success message."""
        with patch(TTS_PATCH, return_value=_mock_tts()):
            resp = await client.post(
                "/v1/tts/initialize", json={"engine": "kokoro"}
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["engine"] == "kokoro"

    @pytest.mark.asyncio
    async def test_initialize_unavailable_returns_503(self, client):
        """TTS unavailable returns 503."""
        with patch(TTS_PATCH, return_value=_mock_tts(available=False)):
            resp = await client.post(
                "/v1/tts/initialize", json={"engine": "kokoro"}
            )
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_initialize_failure_returns_400(self, client):
        """Engine init failure returns 400."""
        tts = _mock_tts()
        tts.initialize_engine.return_value = False
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.post(
                "/v1/tts/initialize", json={"engine": "bad_engine"}
            )
        assert resp.status_code == 400
        assert "Failed to initialize" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_initialize_missing_engine_returns_422(self, client):
        """Missing engine field returns 422."""
        resp = await client.post("/v1/tts/initialize", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_initialize_error_returns_500(self, client):
        """Unexpected error returns 500."""
        with patch(TTS_PATCH, side_effect=RuntimeError("crash")):
            resp = await client.post(
                "/v1/tts/initialize", json={"engine": "kokoro"}
            )
        assert resp.status_code == 500


# ─── /v1/tts/capabilities ────────────────────────────────────────────────────

class TestCapabilities:
    """Tests for GET /v1/tts/capabilities — dynamic dropdown options for frontend."""

    @pytest.mark.asyncio
    async def test_returns_engines_voices_languages(self, client):
        tts = _mock_tts(available=True)
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.get("/v1/tts/capabilities")

        assert resp.status_code == 200
        data = resp.json()

        # Engines
        assert "engines" in data
        assert len(data["engines"]) > 0
        assert all("value" in e and "label" in e and "available" in e for e in data["engines"])

        # At least qwen3 should be available (from mock)
        qwen3 = next((e for e in data["engines"] if e["value"] == "qwen3"), None)
        assert qwen3 is not None
        assert qwen3["available"] is True

        # Voices
        assert "voices" in data
        assert "qwen3" in data["voices"]
        assert "kokoro" in data["voices"]
        assert len(data["voices"]["qwen3"]) > 0
        assert all("value" in v and "label" in v and "language" in v for v in data["voices"]["qwen3"])

        # Languages
        assert "languages" in data
        assert len(data["languages"]) > 0
        assert data["languages"][0]["value"] == ""  # Auto option first
        assert data["languages"][0]["label"] == "Auto (from voice)"

    @pytest.mark.asyncio
    async def test_unavailable_engines_marked_correctly(self, client):
        """Only 'system' available — qwen3/kokoro should be marked unavailable."""
        tts = _mock_tts(available=True, engines=["system"])
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.get("/v1/tts/capabilities")

        data = resp.json()
        for engine in data["engines"]:
            if engine["value"] == "system":
                assert engine["available"] is True
            elif engine["value"] == "qwen3":
                assert engine["available"] is False

    @pytest.mark.asyncio
    async def test_handles_tts_unavailable(self, client):
        """When TTS is not available, all engines should be marked unavailable."""
        tts = _mock_tts(available=False)
        with patch(TTS_PATCH, return_value=tts):
            resp = await client.get("/v1/tts/capabilities")

        assert resp.status_code == 200
        data = resp.json()
        for engine in data["engines"]:
            assert engine["available"] is False
        assert data["current_engine"] is None
