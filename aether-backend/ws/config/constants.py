# Incoming: backend settings --- {Settings, python}
# Processing: Load websocket constants from settings (fail-fast) --- {1 jobs: JOB_LOAD_CONFIG}
# Outgoing: exported module constants --- {int, str, primitives}

"""
WebSocket Configuration Constants

Centralized configuration for WebSocket layer.
All values loaded from settings - no fallbacks.
"""

from config.settings import get_settings

# Load from settings - fail fast if not available
_ws_settings = get_settings().websocket

# WebSocket timeouts (seconds)
WS_SEND_TIMEOUT = _ws_settings.send_timeout
WS_BROADCAST_TIMEOUT = _ws_settings.broadcast_timeout
HEARTBEAT_INTERVAL = _ws_settings.heartbeat_interval
CONNECTION_TIMEOUT = _ws_settings.connection_timeout

# Cache TTL (seconds)
PRESENCE_TTL = _ws_settings.presence_ttl
SESSION_TTL = _ws_settings.session_ttl
COUNTER_TTL = _ws_settings.counter_ttl

# Size limits (bytes)
MAX_MESSAGE_SIZE = _ws_settings.max_message_size
MAX_BINARY_SIZE = _ws_settings.max_binary_size

