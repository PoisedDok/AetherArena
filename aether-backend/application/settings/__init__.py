"""
Application Settings Services

@.architecture
Incoming: api/dependencies.py --- {Settings dependency requests}
Processing: compute runtime settings from central defaults + DB prefs --- {JOB_LOAD_CONFIG, JOB_QUERY_DB, JOB_MERGE_SETTINGS}
Outgoing: api/v1 endpoints, ws handlers --- {Settings}
"""

import threading
from application.settings.runtime_settings_service import RuntimeSettingsService

_runtime_settings_service = None
_init_lock = threading.Lock()

def get_runtime_settings_service() -> RuntimeSettingsService:
    global _runtime_settings_service
    if _runtime_settings_service is None:
        with _init_lock:
            if _runtime_settings_service is None:
                _runtime_settings_service = RuntimeSettingsService()
    return _runtime_settings_service

async def get_runtime_settings(*args, **kwargs):
    return await get_runtime_settings_service().get_runtime_settings(*args, **kwargs)

def invalidate_runtime_settings_cache():
    get_runtime_settings_service().invalidate_cache()

__all__ = [
    "get_runtime_settings_service",
    "get_runtime_settings",
    "invalidate_runtime_settings_cache",
]

