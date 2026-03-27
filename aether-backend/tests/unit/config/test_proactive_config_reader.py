"""
Unit tests for config/proactive_config_reader.py

Covers runtime config path resolution, fallback behavior, type coercion, and
bounded numeric parsing for proactive runtime controls.
"""

import json
from types import SimpleNamespace

from config.proactive_config_reader import config_path_from_app_root, read_proactive_config


def _make_settings(tmp_path):
    worker = SimpleNamespace(
        enabled=True,
        heartbeat_interval_seconds=5,
        max_processing_time_seconds=120,
    )
    daemons = SimpleNamespace(
        browser_enabled=True,
        email_enabled=False,
        file_system_enabled=True,
        query_generation_enabled=True,
        file_indexing_enabled=False,
    )
    proactive = SimpleNamespace(
        enabled=True,
        agent_worker=worker,
        daemons=daemons,
    )
    return SimpleNamespace(app_root=tmp_path, proactive=proactive)


def _write_runtime_config(tmp_path, data):
    config_dir = tmp_path / "data" / "runtime"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "proactive_config.json"
    config_path.write_text(json.dumps(data))
    return config_path


class TestConfigPath:
    def test_config_path_from_app_root(self, tmp_path):
        path = config_path_from_app_root(tmp_path)
        assert path == tmp_path / "data" / "runtime" / "proactive_config.json"


class TestReadProactiveConfig:
    def test_missing_file_uses_settings_defaults(self, tmp_path):
        settings = _make_settings(tmp_path)
        cfg = read_proactive_config(settings)

        assert cfg.enabled is True
        assert cfg.worker_enabled is True
        assert cfg.heartbeat_interval_seconds == 5
        assert cfg.max_processing_time_seconds == 120
        assert cfg.browser_enabled is True
        assert cfg.email_enabled is False
        assert cfg.file_system_enabled is True
        assert cfg.query_generation_enabled is True
        assert cfg.file_indexing_enabled is False
        assert cfg.raw == {}

    def test_runtime_values_are_coerced(self, tmp_path):
        settings = _make_settings(tmp_path)
        _write_runtime_config(
            tmp_path,
            {
                "enabled": "false",
                "worker_enabled": "1",
                "heartbeat_interval_seconds": "9",
                "max_processing_time_seconds": "30",
                "browser_enabled": "0",
                "email_enabled": "true",
                "file_system_enabled": 1,
                "query_generation_enabled": "off",
                "file_indexing_enabled": "on",
            },
        )

        cfg = read_proactive_config(settings)
        assert cfg.enabled is False
        assert cfg.worker_enabled is True
        assert cfg.heartbeat_interval_seconds == 9
        assert cfg.max_processing_time_seconds == 30
        assert cfg.browser_enabled is False
        assert cfg.email_enabled is True
        assert cfg.file_system_enabled is True
        assert cfg.query_generation_enabled is False
        assert cfg.file_indexing_enabled is True

    def test_numeric_values_are_bounded(self, tmp_path):
        settings = _make_settings(tmp_path)
        _write_runtime_config(
            tmp_path,
            {
                "heartbeat_interval_seconds": -20,
                "max_processing_time_seconds": 0,
            },
        )

        cfg = read_proactive_config(settings)
        assert cfg.heartbeat_interval_seconds == 1
        assert cfg.max_processing_time_seconds == 1

    def test_legacy_mode_and_threshold_are_not_mapped(self, tmp_path):
        settings = _make_settings(tmp_path)
        _write_runtime_config(
            tmp_path,
            {"mode": "turbo", "relevance_threshold": 0.91},
        )

        cfg = read_proactive_config(settings)
        assert not hasattr(cfg, "mode")
        assert not hasattr(cfg, "relevance_threshold")
        assert cfg.raw["mode"] == "turbo"
        assert cfg.raw["relevance_threshold"] == 0.91
