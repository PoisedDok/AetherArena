"""Unified proactive runtime config reader.

Eliminates D3 design debt: 5 consumers were reading proactive_config.json
with different fallback logic. This module is the SINGLE reader.

Config file: {settings.app_root}/data/runtime/proactive_config.json
Fallback chain: file value -> settings.proactive.* value -> documented default

@.architecture
Incoming: Runtime config file + Settings object --- {JSON file, Settings}
Processing: Read file, merge with settings defaults --- {1 job: JOB_MERGE_CONFIG}
Outgoing: Frozen ProactiveRuntimeConfig dataclass --- {dataclass}
"""

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict

logger = logging.getLogger(__name__)

RUNTIME_CONFIG_FILENAME = "proactive_config.json"
RUNTIME_CONFIG_SUBPATH = Path("data") / "runtime" / RUNTIME_CONFIG_FILENAME


def config_path_from_app_root(app_root: Path) -> Path:
    """Compute the canonical runtime config file path from app_root."""
    return app_root / RUNTIME_CONFIG_SUBPATH


def _read_file(config_path: Path) -> Dict[str, Any]:
    """Read and parse runtime config file.

    Returns empty dict on any error (file missing, corrupt JSON, permissions).
    Errors are logged at WARNING level so callers need not add their own logging.
    """
    if not config_path.exists():
        return {}
    try:
        with open(config_path, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            logger.warning(
                "Runtime config is not a JSON object: %s", type(data).__name__
            )
            return {}
        return data
    except (OSError, ValueError, TypeError) as e:
        # OSError     — file read / permission
        # ValueError  — bad JSON (JSONDecodeError is a ValueError subclass)
        # TypeError   — unexpected type during json.load
        logger.warning("Failed to read runtime config %s: %s", config_path, e)
        return {}


def _as_bool(value: Any, default: bool) -> bool:
    """Coerce runtime value to bool with safe fallback."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def _as_int(value: Any, default: int, min_value: int = 1) -> int:
    """Coerce runtime value to bounded int with safe fallback."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(min_value, parsed)


@dataclass(frozen=True)
class ProactiveRuntimeConfig:
    """Merged runtime config (file values with settings-based defaults).

    Every field corresponds to a key in the JSON file. When a key is absent
    from the file, the value comes from settings.proactive.*.
    """

    # Master switch
    enabled: bool

    # Worker settings
    worker_enabled: bool
    heartbeat_interval_seconds: int
    max_processing_time_seconds: int

    # Daemon toggles
    browser_enabled: bool
    email_enabled: bool
    file_system_enabled: bool
    query_generation_enabled: bool
    file_indexing_enabled: bool

    # Raw file dict for any consumer that needs extra keys
    raw: Dict[str, Any] = field(default_factory=dict)


def read_proactive_config(settings) -> ProactiveRuntimeConfig:
    """Read proactive runtime config with settings-based fallbacks.

    This is the SINGLE reader for proactive_config.json.
    All consumers MUST use this instead of ad-hoc file reading.

    Fallback chain: file value -> settings.proactive.* -> ProactiveSettings defaults

    Args:
        settings: Application Settings object (must have .app_root and .proactive)

    Returns:
        Frozen dataclass with all resolved config values.
    """
    config_path = config_path_from_app_root(settings.app_root)
    raw = _read_file(config_path)

    worker = settings.proactive.agent_worker
    daemons = settings.proactive.daemons

    return ProactiveRuntimeConfig(
        enabled=_as_bool(raw.get("enabled"), settings.proactive.enabled),
        worker_enabled=_as_bool(raw.get("worker_enabled"), worker.enabled),
        heartbeat_interval_seconds=_as_int(
            raw.get("heartbeat_interval_seconds"),
            worker.heartbeat_interval_seconds,
            min_value=1,
        ),
        max_processing_time_seconds=_as_int(
            raw.get("max_processing_time_seconds"),
            worker.max_processing_time_seconds,
            min_value=1,
        ),
        browser_enabled=_as_bool(raw.get("browser_enabled"), daemons.browser_enabled),
        email_enabled=_as_bool(raw.get("email_enabled"), daemons.email_enabled),
        file_system_enabled=_as_bool(
            raw.get("file_system_enabled"),
            daemons.file_system_enabled,
        ),
        query_generation_enabled=_as_bool(
            raw.get("query_generation_enabled"),
            daemons.query_generation_enabled,
        ),
        file_indexing_enabled=_as_bool(
            raw.get("file_indexing_enabled"),
            daemons.file_indexing_enabled,
        ),
        raw=raw,
    )
