"""
Dynamic Settings Loader

@.architecture
Incoming: get_settings() TOML defaults, PreferencesRepository DB overrides --- {Settings, Dict[str, Any]}
Processing: Merge defaults with user preferences, cache with invalidation --- {3 jobs: JOB_LOAD_DEFAULTS, JOB_LOAD_OVERRIDES, JOB_MERGE_SETTINGS}
Outgoing: Runtime modules, API endpoints --- {Settings, Dict[str, Any]}
"""

from typing import Dict, Any

from config.settings import Settings, IntegrationSettings
from monitoring import get_logger

logger = get_logger(__name__)

def _deep_merge_dict(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """
    Deep-merge `override` onto `base` (dict-only).

    - Dict values merge recursively
    - Non-dict values replace
    """
    result: Dict[str, Any] = dict(base or {})
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge_dict(result[key], value)
        else:
            result[key] = value
    return result


def _apply_integrations_overrides(base_settings: Settings, integrations_prefs: Dict[str, Any]) -> None:
    """
    Apply DB overrides to Settings.integrations (validated).

    Unknown keys are ignored (forward-compatible); known keys are validated via IntegrationSettings.
    """
    if not isinstance(integrations_prefs, dict):
        raise ValueError("integrations preferences must be a dict")

    allowed_keys = set(IntegrationSettings.model_fields.keys())
    filtered = {k: v for k, v in integrations_prefs.items() if k in allowed_keys}
    if not filtered:
        return

    merged = _deep_merge_dict(base_settings.integrations.model_dump(), filtered)
    base_settings.integrations = IntegrationSettings(**merged)
