"""
Open Interpreter Integration Provider — External Mode Only (AGPL Isolation)

OI runs exclusively as an external process (spawned by oi_server_wrapper.py).
Communication is via WebSocket proxy (ExternalOIWebSocketInterpreter) and
HTTP settings API.  No in-process OI code is loaded by the main backend.
"""

from .external_server_pool import ExternalOIServerPool
from .external_ws_proxy import ExternalOIWebSocketInterpreter

__all__ = ["ExternalOIServerPool", "ExternalOIWebSocketInterpreter"]

