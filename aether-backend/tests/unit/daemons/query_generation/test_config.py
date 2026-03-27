"""
Unit tests for services/daemons/query_generation/config.py

Tests QueryGenerationDaemonConfig: settings resolution, validation, fallback.

Covers:
  validate()         -- rejects bad values (interval < 1, missing db_path, etc.)
  from_settings()    -- provider resolution, generation params, override file
  Fallback path      -- when settings import fails
  Default values     -- priority_thresholds, model settings
"""

import pytest
import json
from unittest.mock import patch, MagicMock

from services.daemons.query_generation.config import QueryGenerationDaemonConfig


# ===========================================================================
# validate()
# ===========================================================================

class TestValidate:

    def test_valid_config_passes(self, tmp_path):
        config = QueryGenerationDaemonConfig(
            app_root=tmp_path,
            db_path=tmp_path / "queries.db",
            check_interval_seconds=60,
            context_size=5,
            max_query_terms=10,
        )
        config.validate()  # Should not raise

    def test_check_interval_less_than_1_raises(self, tmp_path):
        config = QueryGenerationDaemonConfig(
            app_root=tmp_path,
            db_path=tmp_path / "queries.db",
            check_interval_seconds=0,
        )
        with pytest.raises(ValueError, match="check_interval_seconds must be >= 1"):
            config.validate()

    def test_missing_db_path_raises(self, tmp_path):
        config = QueryGenerationDaemonConfig(
            app_root=tmp_path,
            db_path=None,
        )
        with pytest.raises(ValueError, match="db_path is required"):
            config.validate()

    def test_context_size_less_than_1_raises(self, tmp_path):
        config = QueryGenerationDaemonConfig(
            app_root=tmp_path,
            db_path=tmp_path / "queries.db",
            context_size=0,
        )
        with pytest.raises(ValueError, match="context_size must be >= 1"):
            config.validate()

    def test_max_query_terms_less_than_1_raises(self, tmp_path):
        config = QueryGenerationDaemonConfig(
            app_root=tmp_path,
            db_path=tmp_path / "queries.db",
            max_query_terms=0,
        )
        with pytest.raises(ValueError, match="max_query_terms must be >= 1"):
            config.validate()

    def test_negative_check_interval_raises(self, tmp_path):
        config = QueryGenerationDaemonConfig(
            app_root=tmp_path,
            db_path=tmp_path / "queries.db",
            check_interval_seconds=-5,
        )
        with pytest.raises(ValueError):
            config.validate()


# ===========================================================================
# Default values
# ===========================================================================

class TestDefaults:

    def test_default_priority_thresholds(self):
        config = QueryGenerationDaemonConfig()
        assert config.priority_thresholds == {
            "email": 1,
            "filesystem": 1,
            "browser": 2,
        }

    def test_default_context_size(self):
        config = QueryGenerationDaemonConfig()
        assert config.context_size == 5

    def test_default_max_query_terms(self):
        config = QueryGenerationDaemonConfig()
        assert config.max_query_terms == 100

    def test_default_llm_settings(self):
        config = QueryGenerationDaemonConfig()
        assert config.llm_temperature == 0.6
        assert config.llm_max_tokens == 4096
        assert config.llm_timeout_seconds == 300.0

    def test_default_query_cleaning(self):
        config = QueryGenerationDaemonConfig()
        assert config.use_lowercase is True
        assert config.remove_special_chars is True

    def test_service_name(self):
        config = QueryGenerationDaemonConfig()
        assert config.service_name == "query_generation_daemon"


# ===========================================================================
# from_settings() -- mock the settings import
# ===========================================================================

class TestFromSettings:
    """Tests for from_settings(). Late imports inside the method require patching at source module."""

    @patch("config.settings.get_settings")
    def test_resolves_provider_from_settings(self, mock_get_settings, tmp_path):
        """from_settings() resolves API base, model, key from central config."""
        # Build mock settings
        mock_settings = MagicMock()
        mock_settings.app_root = tmp_path
        mock_settings.resolve_service_provider.return_value = (
            "http://127.0.0.1:7090/v1",
            "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
            "test-key",
        )
        mock_settings.proactive.query_generation.provider_config = MagicMock()
        mock_settings.proactive.query_generation.llm_model = None  # No override
        mock_settings.proactive.query_generation.check_interval_seconds = 60
        mock_settings.proactive.query_generation.batch_size = 100
        mock_settings.proactive.query_generation.context_size = 5
        mock_settings.proactive.query_generation.log_level = "INFO"
        mock_settings.proactive.query_generation.llm_timeout_seconds = 30.0
        mock_settings.proactive.query_generation.max_query_terms = 10
        mock_settings.proactive.query_generation.use_lowercase = True
        mock_settings.proactive.query_generation.remove_special_chars = True
        mock_settings.inference.get_agent_generation_params.return_value = {
            "temperature": 0.6,
            "max_tokens": 10240,
        }
        mock_get_settings.return_value = mock_settings

        config = QueryGenerationDaemonConfig.from_settings()

        assert config.llm_api_base == "http://127.0.0.1:7090/v1"
        assert config.llm_model == "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"
        assert config.llm_api_key == "test-key"
        assert config.app_root == tmp_path
        assert config.db_path == tmp_path / "data" / "daemons" / "query_generation" / "queries.db"

    @patch("config.settings.get_settings")
    def test_llm_model_override_from_daemon_config(self, mock_get_settings, tmp_path):
        """If daemon config specifies llm_model, it overrides resolved model."""
        mock_settings = MagicMock()
        mock_settings.app_root = tmp_path
        mock_settings.resolve_service_provider.return_value = (
            "http://127.0.0.1:7090/v1",
            "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
            "key",
        )
        mock_settings.proactive.query_generation.provider_config = MagicMock()
        mock_settings.proactive.query_generation.llm_model = "custom-model-override"
        mock_settings.proactive.query_generation.check_interval_seconds = 60
        mock_settings.proactive.query_generation.batch_size = 100
        mock_settings.proactive.query_generation.context_size = 5
        mock_settings.proactive.query_generation.log_level = "INFO"
        mock_settings.proactive.query_generation.llm_timeout_seconds = 30.0
        mock_settings.proactive.query_generation.max_query_terms = 10
        mock_settings.proactive.query_generation.use_lowercase = True
        mock_settings.proactive.query_generation.remove_special_chars = True
        mock_settings.inference.get_agent_generation_params.return_value = {
            "temperature": 0.6,
            "max_tokens": 10240,
        }
        mock_get_settings.return_value = mock_settings

        config = QueryGenerationDaemonConfig.from_settings()
        assert config.llm_model == "custom-model-override"

    @patch("config.settings.get_settings")
    def test_config_override_file_takes_precedence(self, mock_get_settings, tmp_path):
        """Override file llm_model takes precedence over settings."""
        mock_settings = MagicMock()
        mock_settings.app_root = tmp_path
        mock_settings.resolve_service_provider.return_value = (
            "http://127.0.0.1:7090/v1",
            "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit",
            "key",
        )
        mock_settings.proactive.query_generation.provider_config = MagicMock()
        mock_settings.proactive.query_generation.llm_model = None
        mock_settings.proactive.query_generation.check_interval_seconds = 60
        mock_settings.proactive.query_generation.batch_size = 100
        mock_settings.proactive.query_generation.context_size = 5
        mock_settings.proactive.query_generation.log_level = "INFO"
        mock_settings.proactive.query_generation.llm_timeout_seconds = 30.0
        mock_settings.proactive.query_generation.max_query_terms = 10
        mock_settings.proactive.query_generation.use_lowercase = True
        mock_settings.proactive.query_generation.remove_special_chars = True
        mock_settings.inference.get_agent_generation_params.return_value = {
            "temperature": 0.6,
            "max_tokens": 10240,
        }
        mock_get_settings.return_value = mock_settings

        # Create override file
        override_dir = tmp_path / "data" / "daemons" / "query_generation"
        override_dir.mkdir(parents=True, exist_ok=True)
        override_path = override_dir / "config_override.json"
        override_path.write_text(json.dumps({"llm_model": "override-from-file"}))

        config = QueryGenerationDaemonConfig.from_settings()
        assert config.llm_model == "override-from-file"

    @patch("config.settings.get_settings")
    def test_generation_params_from_central_config(self, mock_get_settings, tmp_path):
        """Temperature and max_tokens come from settings.inference.get_agent_generation_params."""
        mock_settings = MagicMock()
        mock_settings.app_root = tmp_path
        mock_settings.resolve_service_provider.return_value = ("http://x", "m", "k")
        mock_settings.proactive.query_generation.provider_config = MagicMock()
        mock_settings.proactive.query_generation.llm_model = None
        mock_settings.proactive.query_generation.check_interval_seconds = 60
        mock_settings.proactive.query_generation.batch_size = 100
        mock_settings.proactive.query_generation.context_size = 5
        mock_settings.proactive.query_generation.log_level = "INFO"
        mock_settings.proactive.query_generation.llm_timeout_seconds = 30.0
        mock_settings.proactive.query_generation.max_query_terms = 10
        mock_settings.proactive.query_generation.use_lowercase = True
        mock_settings.proactive.query_generation.remove_special_chars = True
        mock_settings.inference.get_agent_generation_params.return_value = {
            "temperature": 0.9,
            "max_tokens": 4096,
        }
        mock_get_settings.return_value = mock_settings

        config = QueryGenerationDaemonConfig.from_settings()
        assert config.llm_temperature == 0.9
        assert config.llm_max_tokens == 4096

        # Verify the correct service_type was passed
        mock_settings.inference.get_agent_generation_params.assert_called_once_with("query_gen")

    @patch("config.settings.get_settings", side_effect=Exception("settings unavailable"))
    @patch("utils.config.load_config")
    def test_fallback_when_settings_unavailable(self, mock_load_config, mock_get_settings, tmp_path):
        """When settings import fails, fallback to TOML config."""
        mock_load_config.return_value = {
            "PROVIDERS": {"aether_inference_url": "http://127.0.0.1:7090/v1"},
            "MODELS": {"primary_chat_model": "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"},
        }

        # Patch Path.home() to use tmp_path so dirs are writable
        with patch("pathlib.Path.home", return_value=tmp_path):
            config = QueryGenerationDaemonConfig.from_settings()

        assert config.llm_api_base == "http://127.0.0.1:7090/v1"
        assert config.llm_model == "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"
        assert config.llm_provider == "aether_inference"
