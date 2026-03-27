"""
Unit Tests: Config Loader — utils/config.py

Coverage of load_config (dev/frozen paths), _normalize_model_name,
get_fallback_config, get_llm_settings, get_provider_url.

Mock boundary: filesystem I/O (open/toml.load), sys attributes.
"""

import sys
from unittest.mock import patch, mock_open

from utils.config import (
    load_config,
    get_fallback_config,
    get_llm_settings,
    get_provider_url,
    _normalize_model_name,
)


# =============================================================================
# _normalize_model_name
# =============================================================================


class TestNormalizeModelName:

    def test_aether_inference_prefix(self):
        result = _normalize_model_name("Qwen3-4b-Instruct-2507-MLX-8bit", "aether_inference")
        assert result == "openai/Qwen3-4b-Instruct-2507-MLX-8bit"

    def test_openai_prefix(self):
        result = _normalize_model_name("gpt-4", "openai")
        assert result == "openai/gpt-4"

    def test_openai_compatible_prefix(self):
        result = _normalize_model_name("llama3", "openai-compatible")
        assert result == "openai/llama3"

    def test_lmstudio_prefix(self):
        result = _normalize_model_name("my-model", "lmstudio")
        assert result == "lmstudio/my-model"

    def test_ollama_prefix(self):
        result = _normalize_model_name("mistral", "ollama")
        assert result == "ollama/mistral"

    def test_already_prefixed(self):
        result = _normalize_model_name("openai/gpt-4", "openai")
        assert result == "openai/gpt-4"  # no double prefix

    def test_unknown_provider_passthrough(self):
        result = _normalize_model_name("my-model", "unknown_provider")
        assert result == "my-model"

    def test_empty_provider(self):
        result = _normalize_model_name("model", "")
        assert result == "model"

    def test_none_provider(self):
        result = _normalize_model_name("model", None)
        assert result == "model"

    def test_case_insensitive(self):
        result = _normalize_model_name("model", "OPENAI")
        assert result == "openai/model"

    def test_whitespace_stripped(self):
        result = _normalize_model_name("model", "  ollama  ")
        assert result == "ollama/model"


# =============================================================================
# get_fallback_config
# =============================================================================


class TestGetFallbackConfig:

    def test_structure(self):
        cfg = get_fallback_config()
        assert isinstance(cfg, dict)
        assert "MODELS" in cfg
        assert "PROVIDERS" in cfg
        assert "EMBEDDINGS" in cfg
        assert "OPEN_INTERPRETER" in cfg

    def test_models_keys(self):
        models = get_fallback_config()["MODELS"]
        assert "primary_chat_model" in models
        assert "fallback_chat_model" in models
        assert "primary_embedding_model" in models
        assert "fallback_embedding_model" in models

    def test_providers_keys(self):
        providers = get_fallback_config()["PROVIDERS"]
        assert "aether_inference_url" in providers
        assert "lm_studio_url" in providers
        assert "perplexica_url" in providers
        assert "searxng_url" in providers
        assert "openrouter_url" in providers

    def test_oi_defaults(self):
        oi = get_fallback_config()["OPEN_INTERPRETER"]
        assert oi["context_window"] == 100000
        assert oi["max_tokens"] == 4096
        assert oi["supports_vision"] is True
        assert oi["supports_functions"] is False
        assert oi["offline"] is True
        assert oi["disable_telemetry"] is True


# =============================================================================
# load_config — dev mode
# =============================================================================


class TestLoadConfigDev:

    def test_loads_toml_from_source_tree(self):
        fake_toml = {"MODELS": {"primary_chat_model": "test-model"}}
        m = mock_open(read_data="")

        with patch("builtins.open", m), \
             patch("utils.config.toml.load", return_value=fake_toml), \
             patch.object(sys, "frozen", False, create=True):
            result = load_config()

        assert result == fake_toml

    def test_toml_parse_error_returns_fallback(self):
        m = mock_open(read_data="")

        with patch("builtins.open", m), \
             patch("utils.config.toml.load", side_effect=Exception("parse error")), \
             patch.object(sys, "frozen", False, create=True):
            result = load_config()

        assert result == get_fallback_config()


# =============================================================================
# load_config — frozen/packaged mode
# =============================================================================


class TestLoadConfigFrozen:
    """Frozen-mode config discovery tests.

    Uses monkeypatch.chdir() (actual CWD change) instead of mocking the
    Path.cwd classmethod.  The classmethod mock is unreliable in large test
    suites because it patches a shared class object that other tests may
    also touch, leading to order-dependent failures.
    """

    def test_finds_config_in_cwd(self, tmp_path, monkeypatch):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        config_file = config_dir / "models.toml"
        config_file.write_text('[MODELS]\nprimary_chat_model = "frozen-model"\n')

        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("AETHER_BACKEND_ROOT", raising=False)
        monkeypatch.delattr(sys, "_MEIPASS", raising=False)

        with patch.object(sys, "frozen", True, create=True), \
             patch.object(sys, "executable", str(tmp_path / "app")):

            result = load_config()

        assert result["MODELS"]["primary_chat_model"] == "frozen-model"

    def test_finds_config_in_exe_dir(self, tmp_path, monkeypatch):
        exe_dir = tmp_path / "bin"
        exe_dir.mkdir()
        config_dir = exe_dir / "config"
        config_dir.mkdir()
        config_file = config_dir / "models.toml"
        config_file.write_text('[MODELS]\nprimary_chat_model = "exe-model"\n')

        # CWD has no config — force discovery via exe_dir
        noconfig = tmp_path / "noconfig"
        noconfig.mkdir()
        monkeypatch.chdir(noconfig)
        monkeypatch.delenv("AETHER_BACKEND_ROOT", raising=False)
        monkeypatch.delattr(sys, "_MEIPASS", raising=False)

        with patch.object(sys, "frozen", True, create=True), \
             patch.object(sys, "executable", str(exe_dir / "app")):

            result = load_config()

        assert result["MODELS"]["primary_chat_model"] == "exe-model"

    def test_finds_config_via_backend_root_env(self, tmp_path, monkeypatch):
        """AETHER_BACKEND_ROOT env var takes priority in frozen mode.

        This exercises the os.environ.get() call on line 52 — the exact
        code path that was broken when ``import os`` was missing.
        """
        data_dir = tmp_path / "data"
        config_dir = data_dir / "config"
        config_dir.mkdir(parents=True)
        config_file = config_dir / "models.toml"
        config_file.write_text('[MODELS]\nprimary_chat_model = "env-model"\n')

        # CWD has no config — env var should take priority
        noconfig = tmp_path / "noconfig"
        noconfig.mkdir()
        monkeypatch.chdir(noconfig)
        monkeypatch.setenv("AETHER_BACKEND_ROOT", str(data_dir))
        monkeypatch.delattr(sys, "_MEIPASS", raising=False)

        with patch.object(sys, "frozen", True, create=True), \
             patch.object(sys, "executable", str(tmp_path / "app")):

            result = load_config()

        assert result["MODELS"]["primary_chat_model"] == "env-model"

    def test_fallback_when_no_file_found(self, tmp_path, monkeypatch):
        """All candidate paths missing — falls through to fallback."""
        # Empty CWD, no env var, no _MEIPASS, exe_dir has no config
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.chdir(empty)
        monkeypatch.delenv("AETHER_BACKEND_ROOT", raising=False)
        monkeypatch.delattr(sys, "_MEIPASS", raising=False)

        with patch.object(sys, "frozen", True, create=True), \
             patch.object(sys, "executable", str(tmp_path / "app")):

            result = load_config()

        # Should get fallback config since no file exists
        assert result == get_fallback_config()


# =============================================================================
# get_llm_settings
# =============================================================================


class TestGetLLMSettings:

    def test_returns_expected_structure(self):
        fake_cfg = get_fallback_config()

        with patch("utils.config.load_config", return_value=fake_cfg):
            settings = get_llm_settings()

        assert settings["provider"] == "aether_inference"
        assert settings["api_base"] == "http://127.0.0.1:7090/v1"
        assert settings["model"].startswith("openai/")
        assert settings["supports_vision"] is True
        assert settings["context_window"] == 100000
        assert settings["max_tokens"] == 4096

    def test_model_normalized(self):
        fake_cfg = get_fallback_config()
        fake_cfg["MODELS"]["primary_chat_model"] = "my-custom-model"

        with patch("utils.config.load_config", return_value=fake_cfg):
            settings = get_llm_settings()

        assert settings["model"] == "openai/my-custom-model"


# =============================================================================
# get_provider_url
# =============================================================================


class TestGetProviderUrl:

    def test_aether_inference(self):
        with patch("utils.config.load_config", return_value=get_fallback_config()):
            url = get_provider_url("aether_inference")
        assert url == "http://127.0.0.1:7090/v1"

    def test_lm_studio(self):
        with patch("utils.config.load_config", return_value=get_fallback_config()):
            url = get_provider_url("lm_studio")
        assert url == "http://localhost:1234/v1"

    def test_perplexica(self):
        with patch("utils.config.load_config", return_value=get_fallback_config()):
            url = get_provider_url("perplexica")
        assert url == "http://localhost:3000"

    def test_searxng(self):
        with patch("utils.config.load_config", return_value=get_fallback_config()):
            url = get_provider_url("searxng")
        assert url == "http://127.0.0.1:4040"

    def test_unknown_returns_none(self):
        with patch("utils.config.load_config", return_value=get_fallback_config()):
            url = get_provider_url("nonexistent_provider")
        assert url is None
