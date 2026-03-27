"""
Aether Inference Integration Tests

Tests the full chain:
  local models_dir → manager resolution → vllm-mlx server → InferenceClient → OCR pipeline

Requires:
  - Inference server running on port 7090 (started externally or via test helper)
  - Models in aether-backend/models/ (GLM-OCR-8bit, LFM2.5-1.2B-Instruct-MLX-8bit)
  - Sample files in /Volumes/Disk-D/Aether/Aether/AetherArena/sample/

Run:
  pytest tests/integration/test_aether_inference.py -v --timeout=180

Skip if server unavailable:
  Tests auto-skip when inference server is not reachable.
"""

import asyncio
import base64
import os
import sys
import time
from pathlib import Path

import httpx
import os
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("SKIP_SERVICE_HEALTH_CHECK") == "1",
    reason="Requires live infrastructure"
)


# ---------------------------------------------------------------------------
# Event loop resilience: sync tests (GlmOcrBackend) can pollute the event
# loop via asyncio.get_event_loop().run_until_complete().  Ensure subsequent
# async tests always get a fresh loop.
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _ensure_event_loop():
    """Ensure an event loop exists before each test (repairs loop pollution)."""
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())
    yield
    # No teardown -- let pytest-asyncio manage lifecycle

# Ensure backend root on sys.path
BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

SAMPLE_DIR = REPO_ROOT / "sample"
SAMPLE_IMAGE = SAMPLE_DIR / "unnamed.png"
SAMPLE_PDF = SAMPLE_DIR / "equity_investment_slip-1.pdf"
MODELS_DIR = BACKEND_ROOT / "models"

INFERENCE_PORT = int(os.getenv("INFERENCE_PORT", "7090"))
INFERENCE_BASE = f"http://127.0.0.1:{INFERENCE_PORT}"
INFERENCE_V1 = f"{INFERENCE_BASE}/v1"

GLM_OCR_MODEL_ID = "mlx-community/GLM-OCR-8bit"
LFM_MODEL_ID = "lmstudio-community/LFM2.5-1.2B-Instruct-MLX-8bit"
QWEN3_MODEL_ID = "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"
LFM_VL_MODEL_ID = "lmstudio-community/LFM2.5-VL-1.6B-MLX-6bit"


# ---------------------------------------------------------------------------
# Fixtures / skip conditions
# ---------------------------------------------------------------------------

def _server_reachable() -> bool:
    """Check if inference server is up (sync, for skipif)."""
    try:
        resp = httpx.get(f"{INFERENCE_V1}/models", timeout=3.0)
        return resp.status_code == 200
    except Exception:
        return False


def _server_has_model(substring: str) -> bool:
    """Check if the running server has a model whose ID contains substring."""
    try:
        resp = httpx.get(f"{INFERENCE_V1}/models", timeout=3.0)
        if resp.status_code != 200:
            return False
        data = resp.json()
        return any(substring.lower() in m.get("id", "").lower() for m in data.get("data", []))
    except Exception:
        return False


requires_inference = pytest.mark.skipif(
    not _server_reachable(),
    reason="Aether Inference server not running on port 7090",
)

requires_glm_ocr = pytest.mark.skipif(
    not _server_has_model("GLM-OCR"),
    reason="GLM-OCR model not loaded on inference server",
)

requires_lfm = pytest.mark.skipif(
    not _server_has_model("LFM2.5-1.2B"),
    reason="LFM2.5 text model not loaded on inference server",
)

requires_qwen3 = pytest.mark.skipif(
    not _server_has_model("Qwen3"),
    reason="Qwen3 model not loaded on inference server",
)

requires_lfm_vl = pytest.mark.skipif(
    not _server_has_model("LFM2.5-VL"),
    reason="LFM2.5-VL vision model not loaded on inference server",
)

requires_sample_image = pytest.mark.skipif(
    not SAMPLE_IMAGE.exists(),
    reason=f"Sample image not found: {SAMPLE_IMAGE}",
)

requires_sample_pdf = pytest.mark.skipif(
    not SAMPLE_PDF.exists(),
    reason=f"Sample PDF not found: {SAMPLE_PDF}",
)

requires_local_glm_ocr = pytest.mark.skipif(
    not (MODELS_DIR / GLM_OCR_MODEL_ID / "config.json").exists(),
    reason=f"GLM-OCR model not in local models dir: {MODELS_DIR / GLM_OCR_MODEL_ID}",
)

requires_local_lfm = pytest.mark.skipif(
    not (MODELS_DIR / LFM_MODEL_ID / "config.json").exists(),
    reason=f"LFM2.5 model not in local models dir: {MODELS_DIR / LFM_MODEL_ID}",
)

requires_local_qwen3 = pytest.mark.skipif(
    not (MODELS_DIR / QWEN3_MODEL_ID / "config.json").exists(),
    reason=f"Qwen3 model not in local models dir: {MODELS_DIR / QWEN3_MODEL_ID}",
)

requires_local_lfm_vl = pytest.mark.skipif(
    not (MODELS_DIR / LFM_VL_MODEL_ID / "config.json").exists(),
    reason=f"LFM2.5-VL model not in local models dir: {MODELS_DIR / LFM_VL_MODEL_ID}",
)


# ===========================================================================
# Layer 0: Local Models Directory + Manager Resolution
# ===========================================================================

class TestModelsDirectory:
    """Tests for the local models/ directory and manager model resolution."""

    def test_models_dir_exists(self):
        """models/ directory exists in backend root."""
        assert MODELS_DIR.exists(), f"models/ directory not found at {MODELS_DIR}"
        assert MODELS_DIR.is_dir()

    @requires_local_glm_ocr
    def test_glm_ocr_model_files(self):
        """GLM-OCR model has required files."""
        model_dir = MODELS_DIR / GLM_OCR_MODEL_ID
        assert (model_dir / "config.json").exists()
        assert any(model_dir.glob("*.safetensors")), "No safetensors file found"
        assert (model_dir / "tokenizer.json").exists() or (model_dir / "tokenizer_config.json").exists()

    @requires_local_lfm
    def test_lfm_model_files(self):
        """LFM2.5 model has required files."""
        model_dir = MODELS_DIR / LFM_MODEL_ID
        assert (model_dir / "config.json").exists()
        assert any(model_dir.glob("*.safetensors")), "No safetensors file found"
        assert (model_dir / "tokenizer.json").exists() or (model_dir / "tokenizer_config.json").exists()

    def test_manager_resolve_model_path_local(self):
        """Manager resolves HF model ID to local path when model exists in models_dir."""
        from services.aether_inference.manager import InferenceManager

        manager = InferenceManager.__new__(InferenceManager)
        manager._models_dir = MODELS_DIR
        manager._port = 7090
        manager._venv_path = None

        # GLM-OCR should resolve to local path
        if (MODELS_DIR / GLM_OCR_MODEL_ID / "config.json").exists():
            resolved = manager.resolve_model_path(GLM_OCR_MODEL_ID)
            assert resolved != GLM_OCR_MODEL_ID, "Should resolve to local path, not HF ID"
            assert Path(resolved).is_dir()
            assert (Path(resolved) / "config.json").exists()

        # LFM2.5 should resolve to local path
        if (MODELS_DIR / LFM_MODEL_ID / "config.json").exists():
            resolved = manager.resolve_model_path(LFM_MODEL_ID)
            assert resolved != LFM_MODEL_ID, "Should resolve to local path, not HF ID"
            assert Path(resolved).is_dir()

    def test_manager_resolve_model_path_fallback(self):
        """Manager falls back to HF ID when model not in models_dir."""
        from services.aether_inference.manager import InferenceManager

        manager = InferenceManager.__new__(InferenceManager)
        manager._models_dir = MODELS_DIR
        manager._port = 7090
        manager._venv_path = None

        fake_id = "nonexistent-org/fake-model"
        resolved = manager.resolve_model_path(fake_id)
        assert resolved == fake_id, "Should return original ID when not found locally"

    def test_manager_resolve_absolute_path(self):
        """Manager accepts absolute paths directly."""
        from services.aether_inference.manager import InferenceManager

        manager = InferenceManager.__new__(InferenceManager)
        manager._models_dir = MODELS_DIR
        manager._port = 7090
        manager._venv_path = None

        # Use GLM-OCR absolute path
        glm_path = MODELS_DIR / GLM_OCR_MODEL_ID
        if glm_path.is_dir() and (glm_path / "config.json").exists():
            resolved = manager.resolve_model_path(str(glm_path))
            assert resolved == str(glm_path)

    def test_manager_list_local_models(self):
        """list_local_models() discovers all models in models_dir."""
        from services.aether_inference.manager import InferenceManager

        manager = InferenceManager.__new__(InferenceManager)
        manager._models_dir = MODELS_DIR
        manager._port = 7090
        manager._venv_path = None

        models = manager.list_local_models()
        model_ids = [m["id"] for m in models]

        if (MODELS_DIR / GLM_OCR_MODEL_ID / "config.json").exists():
            assert GLM_OCR_MODEL_ID in model_ids, f"GLM-OCR not found. Found: {model_ids}"

        if (MODELS_DIR / LFM_MODEL_ID / "config.json").exists():
            assert LFM_MODEL_ID in model_ids, f"LFM2.5 not found. Found: {model_ids}"

        # Verify model info structure
        for model in models:
            assert "id" in model
            assert "path" in model
            assert "size_bytes" in model
            assert model["size_bytes"] > 0
            assert "has_safetensors" in model
            assert model["has_safetensors"] is True

    def test_manager_list_local_models_empty_dir(self):
        """list_local_models() returns empty list for nonexistent dir."""
        from services.aether_inference.manager import InferenceManager

        manager = InferenceManager.__new__(InferenceManager)
        manager._models_dir = Path("/nonexistent/models")
        manager._port = 7090
        manager._venv_path = None

        models = manager.list_local_models()
        assert models == []


# ===========================================================================
# Layer 1: Raw HTTP (vllm-mlx server directly) - GLM-OCR Vision
# ===========================================================================

class TestRawInferenceServerGLMOCR:
    """Direct HTTP tests against the on-demand router with GLM-OCR registered."""

    @requires_inference
    @requires_glm_ocr
    @pytest.mark.asyncio
    async def test_health_endpoint(self):
        """Server /health returns healthy with models registered (lazy-loaded on demand)."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{INFERENCE_BASE}/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"
        # On-demand router: model_count > 0 (models registered but may not be loaded yet)
        assert data["model_count"] >= 1
        # GLM-OCR should be in available or loaded list
        all_models = [m["model_id"] for m in data.get("loaded", []) + data.get("available", [])]
        assert any("GLM-OCR" in mid for mid in all_models), f"GLM-OCR not found in: {all_models}"

    @requires_inference
    @requires_glm_ocr
    @pytest.mark.asyncio
    async def test_models_endpoint(self):
        """/v1/models returns at least one model with GLM-OCR."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{INFERENCE_V1}/models")
        assert resp.status_code == 200
        data = resp.json()
        assert data["object"] == "list"
        assert len(data["data"]) >= 1
        # Model ID is now the local path, but contains GLM-OCR
        assert any("GLM-OCR" in m["id"] for m in data["data"])

    @requires_inference
    @requires_glm_ocr
    @requires_sample_image
    @pytest.mark.asyncio
    async def test_chat_completion_with_image(self):
        """Send an image via /v1/chat/completions and get OCR text back."""
        img_bytes = SAMPLE_IMAGE.read_bytes()
        img_b64 = base64.b64encode(img_bytes).decode()

        payload = {
            "model": GLM_OCR_MODEL_ID,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                        {"type": "text", "text": "Text Recognition:"},
                    ],
                }
            ],
            "max_tokens": 2048,
            "temperature": 0.0,
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{INFERENCE_V1}/chat/completions", json=payload)

        if resp.status_code == 503:
            pytest.skip("Inference server returned 503 (model load failure)")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        content = data["choices"][0]["message"]["content"].strip()
        assert len(content) > 20, f"Response too short: {content}"
        assert data["usage"]["completion_tokens"] > 0

    @requires_inference
    @requires_glm_ocr
    @requires_sample_image
    @pytest.mark.asyncio
    async def test_concurrent_ocr_requests(self):
        """Multiple simultaneous OCR requests complete without errors."""
        img_bytes = SAMPLE_IMAGE.read_bytes()
        img_b64 = base64.b64encode(img_bytes).decode()

        payload = {
            "model": GLM_OCR_MODEL_ID,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                        {"type": "text", "text": "Text Recognition:"},
                    ],
                }
            ],
            "max_tokens": 512,
            "temperature": 0.0,
        }

        async def make_request(client: httpx.AsyncClient, idx: int):
            start = time.time()
            resp = await client.post(f"{INFERENCE_V1}/chat/completions", json=payload)
            elapsed = time.time() - start
            return idx, resp.status_code, elapsed

        async with httpx.AsyncClient(timeout=180.0) as client:
            tasks = [make_request(client, i) for i in range(3)]
            results = await asyncio.gather(*tasks, return_exceptions=True)

        # All requests should succeed (server queues them)
        for result in results:
            assert not isinstance(result, Exception), f"Request failed: {result}"
            idx, status, elapsed = result
            if status == 503:
                pytest.skip("Inference server returned 503 (model load failure)")
            assert status == 200, f"Request {idx} returned {status}"


# ===========================================================================
# Layer 2: InferenceClient (our HTTP wrapper)
# ===========================================================================

class TestInferenceClient:
    """Tests for core/integrations/providers/aether_inference/client.py."""

    @requires_inference
    @pytest.mark.asyncio
    async def test_health_check(self):
        """InferenceClient.health_check() returns healthy."""
        from core.integrations.providers.aether_inference.client import InferenceClient
        client = InferenceClient(base_url=INFERENCE_V1)
        result = await client.health_check()
        assert result["healthy"] is True
        assert "response_time_ms" in result

    @requires_inference
    @pytest.mark.asyncio
    async def test_list_models(self):
        """InferenceClient.list_models() returns loaded model."""
        from core.integrations.providers.aether_inference.client import InferenceClient
        client = InferenceClient(base_url=INFERENCE_V1)
        models = await client.list_models()
        assert len(models) >= 1
        # Model ID contains the model name (even when loaded from local path)
        model_ids = [m["id"] for m in models]
        assert any("GLM-OCR" in mid or "LFM" in mid for mid in model_ids), f"Unexpected models: {model_ids}"

    @requires_inference
    @requires_glm_ocr
    @requires_sample_image
    @pytest.mark.asyncio
    async def test_chat_completion_vision(self):
        """InferenceClient.chat_completion() processes image OCR."""
        from core.integrations.providers.aether_inference.client import InferenceClient
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter, GLMOCRTask

        client = InferenceClient(base_url=INFERENCE_V1)
        adapter = GlmOcrAdapter()

        image_url = adapter.encode_image_to_base64_url(SAMPLE_IMAGE)
        messages = adapter.format_recognition_messages(image_url, GLMOCRTask.TEXT)

        try:
            response = await client.chat_completion(messages=messages, model=GLM_OCR_MODEL_ID, max_tokens=2048, temperature=0.0)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 503:
                pytest.skip("Inference server returned 503 (model load failure)")
            raise

        assert "choices" in response
        text = adapter.parse_response(response)
        assert len(text) > 20, f"OCR output too short: {text}"


# ===========================================================================
# Layer 3: GlmOcrAdapter (prompt formatting + response parsing)
# ===========================================================================

class TestGlmOcrAdapter:
    """Tests for core/integrations/providers/aether_inference/glm_ocr.py (no server needed)."""

    def test_encode_image_bytes(self):
        """encode_image_bytes_to_base64_url produces valid data URL."""
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter
        raw = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
        url = GlmOcrAdapter.encode_image_bytes_to_base64_url(raw, "image/png")
        assert url.startswith("data:image/png;base64,")
        b64_part = url.split(",", 1)[1]
        decoded = base64.b64decode(b64_part)
        assert decoded == raw

    @requires_sample_image
    def test_encode_image_file(self):
        """encode_image_to_base64_url works with real file."""
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter
        url = GlmOcrAdapter.encode_image_to_base64_url(SAMPLE_IMAGE)
        assert url.startswith("data:image/png;base64,")
        assert len(url) > 100

    def test_format_recognition_messages_text(self):
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter, GLMOCRTask
        msgs = GlmOcrAdapter.format_recognition_messages("data:image/png;base64,AAAA", GLMOCRTask.TEXT)
        assert len(msgs) == 1
        assert msgs[0]["role"] == "user"
        content = msgs[0]["content"]
        assert len(content) == 2
        assert content[0]["type"] == "image_url"
        assert content[1]["type"] == "text"
        assert content[1]["text"] == "Text Recognition:"

    def test_format_recognition_messages_table(self):
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter, GLMOCRTask
        msgs = GlmOcrAdapter.format_recognition_messages("data:image/png;base64,AAAA", GLMOCRTask.TABLE)
        assert msgs[0]["content"][1]["text"] == "Table Recognition:"

    def test_format_recognition_messages_formula(self):
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter, GLMOCRTask
        msgs = GlmOcrAdapter.format_recognition_messages("data:image/png;base64,AAAA", GLMOCRTask.FORMULA)
        assert msgs[0]["content"][1]["text"] == "Formula Recognition:"

    def test_format_extraction_messages(self):
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter
        schema = '{"name": "string", "amount": "number"}'
        msgs = GlmOcrAdapter.format_extraction_messages("data:image/png;base64,AAAA", schema)
        assert schema in msgs[0]["content"][1]["text"]

    def test_parse_response_normal(self):
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter
        response = {"choices": [{"message": {"content": "  Hello World  "}}]}
        assert GlmOcrAdapter.parse_response(response) == "Hello World"

    def test_parse_response_empty_choices(self):
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter
        assert GlmOcrAdapter.parse_response({"choices": []}) == ""

    def test_parse_response_missing_keys(self):
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter
        assert GlmOcrAdapter.parse_response({}) == ""

    def test_info_extraction_rejects_for_recognition(self):
        from core.integrations.providers.aether_inference.glm_ocr import GlmOcrAdapter, GLMOCRTask
        with pytest.raises(ValueError, match="extraction"):
            GlmOcrAdapter.format_recognition_messages("data:image/png;base64,AAAA", GLMOCRTask.INFO_EXTRACTION)


# ===========================================================================
# Layer 4: GlmOcrBackend (OCR registry integration)
# ===========================================================================

class TestGlmOcrBackend:
    """Tests for core/integrations/libraries/ocr/glm_ocr_backend.py."""

    def test_backend_instantiation(self):
        from core.integrations.libraries.ocr.glm_ocr_backend import GlmOcrBackend
        backend = GlmOcrBackend()
        assert backend.backend_type.value == "glm_ocr"

    def test_is_available(self):
        from core.integrations.libraries.ocr.glm_ocr_backend import GlmOcrBackend
        backend = GlmOcrBackend()
        assert backend.is_available() is True

    def test_capabilities(self):
        from core.integrations.libraries.ocr.glm_ocr_backend import GlmOcrBackend
        backend = GlmOcrBackend()
        caps = backend.get_capabilities()
        assert caps.supports_pdf is False  # PDFs go through Docling, not GLM-OCR
        assert caps.supports_images is True
        assert caps.supports_tables is True
        assert caps.supports_formulas is True
        assert caps.supports_multilang is True
        assert caps.requires_gpu is False
        assert caps.memory_mb == 0

    @requires_inference
    @requires_glm_ocr
    @pytest.mark.asyncio
    async def test_health_check(self, monkeypatch):
        from core.integrations.libraries.ocr.glm_ocr_backend import GlmOcrBackend
        monkeypatch.setenv("INFERENCE_PORT", str(INFERENCE_PORT))
        backend = GlmOcrBackend()
        health = await backend.check_health()
        assert health["healthy"] is True
        assert health["backend"] == "glm_ocr"

    @requires_inference
    @requires_glm_ocr
    @requires_sample_image
    def test_process_file_image(self):
        from core.integrations.libraries.ocr.glm_ocr_backend import GlmOcrBackend
        from core.integrations.libraries.ocr.base import OCRTask
        backend = GlmOcrBackend()
        result = backend.process_file(str(SAMPLE_IMAGE), task=OCRTask.OCR)
        if not result.success and "503 Service Unavailable" in result.error:
            pytest.skip("Inference server returned 503 (model load failure)")
        assert result.success is True, f"OCR failed: {result.error}"
        assert len(result.text) > 20, f"OCR text too short: {result.text}"
        assert result.backend == "glm_ocr"
        assert result.processing_time > 0

    @requires_inference
    @requires_glm_ocr
    @requires_sample_image
    def test_process_upload_image(self):
        from core.integrations.libraries.ocr.glm_ocr_backend import GlmOcrBackend
        from core.integrations.libraries.ocr.base import OCRTask
        backend = GlmOcrBackend()
        img_bytes = SAMPLE_IMAGE.read_bytes()
        result = backend.process_upload(img_bytes, "unnamed.png", task=OCRTask.OCR)
        if not result.success and "503 Service Unavailable" in result.error:
            pytest.skip("Inference server returned 503 (model load failure)")
        assert result.success is True, f"OCR failed: {result.error}"
        assert len(result.text) > 20

    @requires_sample_pdf
    def test_process_file_pdf_rejected(self):
        """GLM-OCR rejects PDFs — they must go through the Docling pipeline."""
        from core.integrations.libraries.ocr.glm_ocr_backend import GlmOcrBackend
        from core.integrations.libraries.ocr.base import OCRTask
        backend = GlmOcrBackend()
        result = backend.process_file(str(SAMPLE_PDF), task=OCRTask.OCR)
        assert result.success is False, "PDF should be rejected by GLM-OCR (image-only backend)"
        assert "docling" in result.error.lower(), f"Error should mention Docling pipeline: {result.error}"
        assert ".pdf" in result.error.lower(), f"Error should mention the file extension: {result.error}"

    def test_process_file_nonexistent(self):
        from core.integrations.libraries.ocr.glm_ocr_backend import GlmOcrBackend
        from core.integrations.libraries.ocr.base import OCRTask
        backend = GlmOcrBackend()
        result = backend.process_file("/nonexistent/path.png", task=OCRTask.OCR)
        assert result.success is False
        assert "not found" in result.error.lower()


# ===========================================================================
# Layer 5: Platform Detection
# ===========================================================================

class TestPlatformDetection:
    """Tests for services/aether_inference/platform.py."""

    def test_detect_platform_returns_info(self):
        from services.aether_inference.platform_detector import detect_platform, PlatformInfo
        info = detect_platform()
        assert isinstance(info, PlatformInfo)
        assert info.os in ("darwin", "linux", "windows")
        assert info.arch in ("arm64", "x86_64", "amd64")

    def test_apple_silicon_uses_vllm_mlx(self):
        import platform as platmod
        if platmod.system().lower() != "darwin" or platmod.machine().lower() != "arm64":
            pytest.skip("Not Apple Silicon")

        from services.aether_inference.platform_detector import detect_platform, InferenceEngine
        info = detect_platform()
        assert info.engine == InferenceEngine.VLLM_MLX
        assert info.engine_command == "python"
        assert "-m" in info.engine_serve_args
        assert "vllm_mlx.server" in info.engine_serve_args
        assert "--mllm" in info.engine_serve_args
        assert info.glm_ocr_model == "mlx-community/GLM-OCR-8bit"

    def test_pip_install_target_is_git(self):
        import platform as platmod
        if platmod.system().lower() != "darwin" or platmod.machine().lower() != "arm64":
            pytest.skip("Not Apple Silicon")

        from services.aether_inference.platform_detector import detect_platform
        info = detect_platform()
        assert "git+https://" in info.pip_install_target
        assert "waybarrios/vllm-mlx" in info.pip_install_target


# ===========================================================================
# Layer 6: Manager Command Building + models_dir integration
# ===========================================================================

class TestInferenceManagerCommand:
    """Tests for services/aether_inference/manager.py command construction."""

    @staticmethod
    def _make_stub_manager(**overrides):
        """Create an InferenceManager stub with all required attributes."""
        from services.aether_inference.manager import InferenceManager
        manager = InferenceManager.__new__(InferenceManager)
        defaults = {
            "_port": 7090,
            "_venv_path": Path("/fake/venv"),
            "_models_dir": None,
            "_idle_timeout": 600,
            "_current_model": None,
            "_platform": None,
            "_service_source_dir": None,
        }
        defaults.update(overrides)
        for k, v in defaults.items():
            setattr(manager, k, v)
        manager._resolve_engine_binary = lambda: "/fake/venv/bin/python"
        return manager

    def test_build_serve_command_vllm_mlx(self):
        """On Apple Silicon, command uses python -m vllm_mlx.server --mllm."""
        import platform as platmod
        if platmod.system().lower() != "darwin" or platmod.machine().lower() != "arm64":
            pytest.skip("Not Apple Silicon")

        manager = self._make_stub_manager()

        cmd = manager._build_serve_command(GLM_OCR_MODEL_ID)
        assert cmd[0] == "/fake/venv/bin/python"
        assert "-m" in cmd
        assert any("aether_inference.server" in a for a in cmd)
        assert "--model" in cmd
        assert GLM_OCR_MODEL_ID in cmd
        assert "--port" in cmd
        assert "7090" in cmd

    @requires_local_glm_ocr
    def test_build_serve_command_with_models_dir(self):
        """Command resolves model to local path when models_dir configured."""
        import platform as platmod
        if platmod.system().lower() != "darwin" or platmod.machine().lower() != "arm64":
            pytest.skip("Not Apple Silicon")

        manager = self._make_stub_manager(_models_dir=MODELS_DIR)

        cmd = manager._build_serve_command(GLM_OCR_MODEL_ID)
        # The --models-dir arg should be present
        assert "--models-dir" in cmd
        assert str(MODELS_DIR) in cmd


# ===========================================================================
# Layer 7: LFM2.5 Text Model (requires LFM loaded)
# ===========================================================================

class TestLFMTextModel:
    """Tests for LFM2.5 text-only model via inference server.
    
    These tests require the server to be running with LFM2.5 loaded.
    Since vllm-mlx is single-model, these skip if GLM-OCR is loaded instead.
    """

    @requires_inference
    @requires_lfm
    @pytest.mark.asyncio
    async def test_lfm_text_completion(self):
        """LFM2.5 generates coherent text for a simple prompt."""
        payload = {
            "model": LFM_MODEL_ID,
            "messages": [
                {"role": "user", "content": "What is 2 + 2? Answer in one word."}
            ],
            "max_tokens": 32,
            "temperature": 0.0,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{INFERENCE_V1}/chat/completions", json=payload)

        assert resp.status_code == 200, resp.text
        data = resp.json()
        content = data["choices"][0]["message"]["content"].strip()
        assert len(content) > 0, "Empty response from LFM2.5"
        assert data["usage"]["completion_tokens"] > 0

    @requires_inference
    @requires_lfm
    @pytest.mark.asyncio
    async def test_lfm_longer_generation(self):
        """LFM2.5 handles longer text generation."""
        payload = {
            "model": LFM_MODEL_ID,
            "messages": [
                {"role": "user", "content": "Explain what machine learning is in 2-3 sentences."}
            ],
            "max_tokens": 256,
            "temperature": 0.1,
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{INFERENCE_V1}/chat/completions", json=payload)

        assert resp.status_code == 200, resp.text
        data = resp.json()
        content = data["choices"][0]["message"]["content"].strip()
        assert len(content) > 50, f"Response too short for explanation: {content}"

    @requires_inference
    @requires_lfm
    @pytest.mark.asyncio
    async def test_lfm_concurrent_requests(self):
        """Multiple simultaneous text requests to LFM2.5 complete without errors."""
        payload = {
            "model": LFM_MODEL_ID,
            "messages": [
                {"role": "user", "content": "Say hello."}
            ],
            "max_tokens": 16,
            "temperature": 0.0,
        }

        async def make_request(client: httpx.AsyncClient, idx: int):
            resp = await client.post(f"{INFERENCE_V1}/chat/completions", json=payload)
            return idx, resp.status_code

        async with httpx.AsyncClient(timeout=60.0) as client:
            tasks = [make_request(client, i) for i in range(3)]
            results = await asyncio.gather(*tasks, return_exceptions=True)

        for result in results:
            assert not isinstance(result, Exception), f"Request failed: {result}"
            idx, status = result
            assert status == 200, f"Request {idx} returned {status}"


# ===========================================================================
# Layer 8: Settings Integration
# ===========================================================================

class TestSettingsIntegration:
    """Tests that settings.py correctly resolves models_dir."""

    def test_settings_has_models_dir(self):
        """InferenceSettings includes models_dir field."""
        from config.settings import get_settings
        settings = get_settings()
        assert hasattr(settings.inference, "models_dir")
        assert settings.inference.models_dir  # Should be non-empty (dynamically resolved)

    def test_settings_models_dir_is_valid_path(self):
        """models_dir from settings is a valid directory path."""
        from config.settings import get_settings
        settings = get_settings()
        models_dir = Path(settings.inference.models_dir)
        # In dev mode, should point to BACKEND_ROOT/models
        assert "models" in str(models_dir)


# ===========================================================================
# Layer 8b: Model Parameters Extraction (offline)
# ===========================================================================

class TestModelParamsExtraction:
    """Tests for _extract_model_params reading config.json + generation_config.json."""

    def test_lfm_text_context_length(self):
        """LFM 2.5 text has 128k context from max_position_embeddings."""
        from services.aether_inference.server import InferenceRouter
        model_dir = MODELS_DIR / LFM_MODEL_ID
        if not model_dir.exists():
            pytest.skip("LFM model not downloaded")
        params = InferenceRouter._extract_model_params(str(model_dir))
        assert params.context_length == 128000
        assert params.vocab_size == 65536
        assert params.hidden_size == 2048
        assert params.num_layers == 16

    def test_qwen3_context_length(self):
        """Qwen 3.5 4B has 262k context and generation defaults from generation_config.json."""
        from services.aether_inference.server import InferenceRouter
        model_dir = MODELS_DIR / QWEN3_MODEL_ID
        if not model_dir.exists():
            pytest.skip("Qwen3 model not downloaded")
        params = InferenceRouter._extract_model_params(str(model_dir))
        assert params.context_length == 262144
        assert params.default_temperature == 0.7
        assert params.default_top_p == 0.8
        assert params.default_top_k == 20

    def test_glm_ocr_context_from_nested(self):
        """GLM-OCR has context in text_config.max_position_embeddings (nested)."""
        from services.aether_inference.server import InferenceRouter
        model_dir = MODELS_DIR / GLM_OCR_MODEL_ID
        if not model_dir.exists():
            pytest.skip("GLM-OCR model not downloaded")
        params = InferenceRouter._extract_model_params(str(model_dir))
        assert params.context_length == 131072
        assert params.vocab_size == 59392  # from text_config
        assert params.hidden_size == 1536

    def test_lfm_vl_context_from_nested(self):
        """LFM 2.5 VL has context in text_config.max_position_embeddings (nested)."""
        from services.aether_inference.server import InferenceRouter
        model_dir = MODELS_DIR / LFM_VL_MODEL_ID
        if not model_dir.exists():
            pytest.skip("LFM-VL model not downloaded")
        params = InferenceRouter._extract_model_params(str(model_dir))
        assert params.context_length == 128000
        assert params.vocab_size == 65536

    def test_nonexistent_returns_defaults(self):
        """Non-existent path returns default ModelParams."""
        from services.aether_inference.server import InferenceRouter
        params = InferenceRouter._extract_model_params("/nonexistent/path")
        assert params.context_length == 4096  # default
        assert params.default_temperature == 0.7


# ===========================================================================
# Layer 9: Tool Call Support Detection
# ===========================================================================

class TestToolCallDetection:
    """Tests for model tool/function calling capability detection."""

    def test_tool_detection_lfm_text(self):
        """LFM 2.5 text model supports tool calls."""
        from services.aether_inference.server import InferenceRouter
        model_dir = MODELS_DIR / LFM_MODEL_ID
        if not model_dir.exists():
            pytest.skip("LFM model not downloaded")
        assert InferenceRouter._detect_tool_support(str(model_dir)) is True

    def test_tool_detection_qwen3(self):
        """Qwen3 model supports tool calls."""
        from services.aether_inference.server import InferenceRouter
        model_dir = MODELS_DIR / QWEN3_MODEL_ID
        if not model_dir.exists():
            pytest.skip("Qwen3 model not downloaded")
        assert InferenceRouter._detect_tool_support(str(model_dir)) is True

    def test_tool_detection_glm_ocr(self):
        """GLM-OCR model has tool call template (inherited from GLM arch)."""
        from services.aether_inference.server import InferenceRouter
        model_dir = MODELS_DIR / GLM_OCR_MODEL_ID
        if not model_dir.exists():
            pytest.skip("GLM-OCR model not downloaded")
        assert InferenceRouter._detect_tool_support(str(model_dir)) is True

    def test_tool_detection_lfm_vl(self):
        """LFM 2.5 VL vision model supports tool calls."""
        from services.aether_inference.server import InferenceRouter
        model_dir = MODELS_DIR / LFM_VL_MODEL_ID
        if not model_dir.exists():
            pytest.skip("LFM-VL model not downloaded")
        assert InferenceRouter._detect_tool_support(str(model_dir)) is True

    def test_tool_detection_nonexistent(self):
        """Non-existent model path returns False."""
        from services.aether_inference.server import InferenceRouter
        assert InferenceRouter._detect_tool_support("/nonexistent/model") is False


# ===========================================================================
# Layer 10: Model Type Detection for All 4 Models
# ===========================================================================

class TestModelTypeDetection:
    """Tests that the server correctly classifies each model's type."""

    def test_glm_ocr_is_vision(self):
        """GLM-OCR is detected as vision model."""
        from services.aether_inference.server import InferenceRouter
        router = InferenceRouter.__new__(InferenceRouter)
        model_dir = MODELS_DIR / GLM_OCR_MODEL_ID
        if not model_dir.exists():
            pytest.skip("GLM-OCR model not downloaded")
        assert router._detect_model_type(str(model_dir)) == "vision"

    def test_lfm_text_is_text(self):
        """LFM 2.5 text model is detected as text."""
        from services.aether_inference.server import InferenceRouter
        router = InferenceRouter.__new__(InferenceRouter)
        model_dir = MODELS_DIR / LFM_MODEL_ID
        if not model_dir.exists():
            pytest.skip("LFM model not downloaded")
        assert router._detect_model_type(str(model_dir)) == "text"

    @requires_local_qwen3
    def test_qwen3_is_text(self):
        """Qwen3 is detected as text model."""
        from services.aether_inference.server import InferenceRouter
        router = InferenceRouter.__new__(InferenceRouter)
        model_dir = MODELS_DIR / QWEN3_MODEL_ID
        assert router._detect_model_type(str(model_dir)) == "text"

    @requires_local_lfm_vl
    def test_lfm_vl_is_vision(self):
        """LFM 2.5 VL is detected as vision model (via vision_config or image_token_id)."""
        from services.aether_inference.server import InferenceRouter
        router = InferenceRouter.__new__(InferenceRouter)
        model_dir = MODELS_DIR / LFM_VL_MODEL_ID
        assert router._detect_model_type(str(model_dir)) == "vision"


# ===========================================================================
# Layer 11: Server Model Discovery (all 4 models)
# ===========================================================================

class TestServerModelDiscovery:
    """Tests that the server discovers and registers all 4 recommended models."""

    def test_discover_all_four_models(self):
        """Server discovers all 4 models in models_dir."""
        from services.aether_inference.server import InferenceRouter
        router = InferenceRouter(
            port=0,
            models_dir=str(MODELS_DIR),
            engine="vllm-mlx",
        )
        router.discover_models()

        found_ids = set(router._registry.keys())
        expected = {GLM_OCR_MODEL_ID, LFM_MODEL_ID, QWEN3_MODEL_ID, LFM_VL_MODEL_ID}
        missing = expected - found_ids
        # Only check models that are actually downloaded
        for model_id in expected:
            model_dir = MODELS_DIR / model_id
            if model_dir.exists() and (model_dir / "config.json").exists():
                assert model_id in found_ids, f"Model {model_id} not discovered. Found: {found_ids}"

    def test_discovered_models_have_correct_types(self):
        """Discovered models have correct type assignments."""
        from services.aether_inference.server import InferenceRouter
        router = InferenceRouter(
            port=0,
            models_dir=str(MODELS_DIR),
            engine="vllm-mlx",
        )
        router.discover_models()

        type_expectations = {
            GLM_OCR_MODEL_ID: "vision",
            LFM_MODEL_ID: "text",
            QWEN3_MODEL_ID: "vision",
            LFM_VL_MODEL_ID: "vision",
        }
        for model_id, expected_type in type_expectations.items():
            if model_id in router._registry:
                entry = router._registry[model_id]
                assert entry.model_type == expected_type, (
                    f"{model_id}: expected type={expected_type}, got {entry.model_type}"
                )

    def test_discovered_models_have_tool_support_flags(self):
        """Discovered models have correct supports_tools flags."""
        from services.aether_inference.server import InferenceRouter
        router = InferenceRouter(
            port=0,
            models_dir=str(MODELS_DIR),
            engine="vllm-mlx",
        )
        router.discover_models()

        # All 4 models have tool support in their chat templates
        for model_id in [GLM_OCR_MODEL_ID, LFM_MODEL_ID, QWEN3_MODEL_ID, LFM_VL_MODEL_ID]:
            if model_id in router._registry:
                entry = router._registry[model_id]
                assert entry.supports_tools is True, (
                    f"{model_id}: expected supports_tools=True, got {entry.supports_tools}"
                )

    def test_discovered_models_have_context_lengths(self):
        """Discovered models have non-default context lengths from config.json."""
        from services.aether_inference.server import InferenceRouter
        router = InferenceRouter(
            port=0,
            models_dir=str(MODELS_DIR),
            engine="vllm-mlx",
        )
        router.discover_models()

        for model_id in [GLM_OCR_MODEL_ID, LFM_MODEL_ID, QWEN3_MODEL_ID, LFM_VL_MODEL_ID]:
            if model_id in router._registry:
                entry = router._registry[model_id]
                assert entry.params.context_length > 4096, (
                    f"{model_id}: expected context_length > 4096, got {entry.params.context_length}"
                )

    def test_model_routing_text_goes_to_text(self):
        """Text requests route to a text model (LFM or Qwen3)."""
        from services.aether_inference.server import InferenceRouter
        router = InferenceRouter(
            port=0,
            models_dir=str(MODELS_DIR),
            engine="vllm-mlx",
        )
        router.discover_models()

        model_id = router.find_model_id(None, has_images=False)
        if model_id:
            entry = router._registry[model_id]
            assert entry.model_type == "text", f"Text request routed to {entry.model_type} model: {model_id}"

    def test_model_routing_vision_goes_to_vision(self):
        """Image requests route to a vision model (GLM-OCR or LFM-VL)."""
        from services.aether_inference.server import InferenceRouter
        router = InferenceRouter(
            port=0,
            models_dir=str(MODELS_DIR),
            engine="vllm-mlx",
        )
        router.discover_models()

        model_id = router.find_model_id(None, has_images=True)
        if model_id:
            entry = router._registry[model_id]
            assert entry.model_type == "vision", f"Vision request routed to {entry.model_type} model: {model_id}"


# ===========================================================================
# Layer 12: Qwen3 Model Tests (requires server with Qwen3)
# ===========================================================================

class TestQwen3Model:
    """Tests for Qwen 3.5 4B model via inference server."""

    @requires_inference
    @requires_qwen3
    @pytest.mark.asyncio
    async def test_qwen3_text_completion(self):
        """Qwen3 generates coherent text for a simple prompt."""
        payload = {
            "model": QWEN3_MODEL_ID,
            "messages": [
                {"role": "user", "content": "What is the capital of France? Answer in one word."}
            ],
            "max_tokens": 64,
            "temperature": 0.0,
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{INFERENCE_V1}/chat/completions", json=payload)

        assert resp.status_code == 200, resp.text
        data = resp.json()
        content = data["choices"][0]["message"]["content"].strip()
        assert len(content) > 0, "Empty response from Qwen3"
        assert data["usage"]["completion_tokens"] > 0

    @requires_inference
    @requires_qwen3
    @pytest.mark.asyncio
    async def test_qwen3_tool_call(self):
        """Qwen3 generates a tool call when given tools."""
        payload = {
            "model": QWEN3_MODEL_ID,
            "messages": [
                {"role": "user", "content": "What's the weather in San Francisco?"}
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "description": "Get the current weather for a location",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "location": {
                                    "type": "string",
                                    "description": "City name",
                                }
                            },
                            "required": ["location"],
                        },
                    },
                }
            ],
            "tool_choice": "auto",
            "max_tokens": 256,
            "temperature": 0.0,
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{INFERENCE_V1}/chat/completions", json=payload)

        assert resp.status_code == 200, resp.text
        data = resp.json()
        msg = data["choices"][0]["message"]
        # The model should either produce tool_calls or mention weather in content.
        # When tool_calls are present, content may be None (not empty string).
        has_tool_calls = bool(msg.get("tool_calls"))
        content = msg.get("content") or ""
        has_content = bool(content.strip())
        assert has_tool_calls or has_content, f"Neither tool_calls nor content: {msg}"


# ===========================================================================
# Layer 13: LFM2.5-VL Vision Model Tests (requires server with VL model)
# ===========================================================================

class TestLFMVisionModel:
    """Tests for LFM2.5-VL vision-language model via inference server."""

    @requires_inference
    @requires_lfm_vl
    @requires_sample_image
    @pytest.mark.asyncio
    async def test_lfm_vl_image_description(self):
        """LFM2.5-VL generates a description for an image."""
        img_bytes = SAMPLE_IMAGE.read_bytes()
        img_b64 = base64.b64encode(img_bytes).decode()

        payload = {
            "model": LFM_VL_MODEL_ID,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                        {"type": "text", "text": "Describe this image briefly."},
                    ],
                }
            ],
            "max_tokens": 256,
            "temperature": 0.0,
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{INFERENCE_V1}/chat/completions", json=payload)

        assert resp.status_code == 200, resp.text
        data = resp.json()
        content = data["choices"][0]["message"]["content"].strip()
        assert len(content) > 10, f"VL response too short: {content}"
        assert data["usage"]["completion_tokens"] > 0


# ===========================================================================
# Layer 14: /v1/models Capabilities Metadata
# ===========================================================================

class TestModelsEndpointCapabilities:
    """Tests that /v1/models returns capabilities, parameters, and architecture metadata."""

    @requires_inference
    @pytest.mark.asyncio
    async def test_models_have_capabilities(self):
        """/v1/models returns capabilities for each model."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{INFERENCE_V1}/models")
        assert resp.status_code == 200
        data = resp.json()
        for model in data["data"]:
            assert "capabilities" in model, f"Model {model['id']} missing capabilities"
            caps = model["capabilities"]
            assert "vision" in caps
            assert "tool_use" in caps
            assert "streaming" in caps
            assert caps["streaming"] is True

    @requires_inference
    @pytest.mark.asyncio
    async def test_models_have_supports_tools(self):
        """/v1/models returns supports_tools flag."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{INFERENCE_V1}/models")
        assert resp.status_code == 200
        data = resp.json()
        for model in data["data"]:
            assert "supports_tools" in model, f"Model {model['id']} missing supports_tools"
            assert isinstance(model["supports_tools"], bool)

    @requires_inference
    @pytest.mark.asyncio
    async def test_vision_model_has_vision_capability(self):
        """Vision models are flagged with capabilities.vision=true."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{INFERENCE_V1}/models")
        assert resp.status_code == 200
        data = resp.json()
        for model in data["data"]:
            if model.get("model_type") == "vision":
                assert model["capabilities"]["vision"] is True
            elif model.get("model_type") == "text":
                assert model["capabilities"]["vision"] is False

    @requires_inference
    @pytest.mark.asyncio
    async def test_models_have_parameters(self):
        """/v1/models returns parameters block with inference defaults."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{INFERENCE_V1}/models")
        assert resp.status_code == 200
        data = resp.json()
        for model in data["data"]:
            assert "parameters" in model, f"Model {model['id']} missing parameters"
            params = model["parameters"]
            assert "context_length" in params
            assert isinstance(params["context_length"], int)
            assert params["context_length"] > 0, f"Model {model['id']} has zero context_length"
            assert "default_temperature" in params
            assert isinstance(params["default_temperature"], (int, float))
            assert "default_top_p" in params
            assert "default_top_k" in params
            assert "default_max_tokens" in params
            assert "repeat_penalty" in params
            assert "do_sample" in params

    @requires_inference
    @pytest.mark.asyncio
    async def test_models_have_architecture(self):
        """/v1/models returns architecture block with model shape info."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{INFERENCE_V1}/models")
        assert resp.status_code == 200
        data = resp.json()
        for model in data["data"]:
            assert "architecture" in model, f"Model {model['id']} missing architecture"
            arch = model["architecture"]
            assert "vocab_size" in arch
            assert "hidden_size" in arch
            assert "num_layers" in arch

    @requires_inference
    @pytest.mark.asyncio
    async def test_context_lengths_are_correct(self):
        """Known models have expected context lengths from config.json."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{INFERENCE_V1}/models")
        assert resp.status_code == 200
        data = resp.json()

        expected_ctx = {
            "LFM2.5-1.2B-Instruct": 128000,
            "Qwen3-4b": 262144,
            "GLM-OCR": [131072, 4096],
            "LFM2.5-VL": 128000,
        }
        for model in data["data"]:
            for name_fragment, expected_len in expected_ctx.items():
                if name_fragment in model["id"]:
                    actual = model["parameters"]["context_length"]
                    if isinstance(expected_len, list):
                        assert actual in expected_len, f"{model['id']}: expected context_length in {expected_len}, got {actual}"
                    else:
                        assert actual == expected_len, (
                            f"{model['id']}: expected context_length={expected_len}, got {actual}"
                        )


# ===========================================================================
# Layer 15: LFM Text Model with Tool Calls
# ===========================================================================

class TestLFMToolCalls:
    """Tests for LFM 2.5 text model tool call support."""

    @requires_inference
    @requires_lfm
    @pytest.mark.asyncio
    async def test_lfm_tool_call(self):
        """LFM 2.5 can handle a tool call request."""
        payload = {
            "model": LFM_MODEL_ID,
            "messages": [
                {"role": "user", "content": "Search for recent news about AI."}
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "search_news",
                        "description": "Search for recent news articles",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "query": {
                                    "type": "string",
                                    "description": "Search query",
                                }
                            },
                            "required": ["query"],
                        },
                    },
                }
            ],
            "tool_choice": "auto",
            "max_tokens": 256,
            "temperature": 0.0,
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{INFERENCE_V1}/chat/completions", json=payload)

        assert resp.status_code == 200, resp.text
        data = resp.json()
        msg = data["choices"][0]["message"]
        # Model should produce some response (tool_calls or content)
        has_tool_calls = bool(msg.get("tool_calls"))
        has_content = bool(msg.get("content", "").strip())
        assert has_tool_calls or has_content, f"Neither tool_calls nor content: {msg}"
