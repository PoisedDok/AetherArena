"""
@.architecture

Incoming: presentation --- {str, Optional[str], primitives}
Processing: ID mapping, duplicate detection, cleanup coordination --- {2 jobs: JOB_ROUTE_BY_ID, JOB_LOG}
Outgoing: presentation --- {str, bool, primitives}

Request Mapper - Frontend↔Backend ID mapping service

Application service for managing request ID mappings.
Thread-safe, tracks frontend→backend relationships.

Architecture note:
  Aether is a multi-window Electron app.  Each window (main, chat, artifacts)
  maintains its OWN WebSocket connection to the backend, yielding a different
  client_id per window.  A user message may arrive from the chat window's
  client_id while the stop signal arrives from a DIFFERENT window's client_id.
  Therefore, ID resolution MUST be global — not scoped per client.
  Per-client maps are retained solely for efficient cleanup on disconnect.

Features:
- Register frontend_id → backend_id mappings (global + per-client)
- Resolve backend_id from ANY known ID (global O(1) lookup)
- Duplicate detection
- Cleanup on completion / disconnect
"""

import asyncio
from collections import defaultdict
from typing import Dict, Optional
import logging

logger = logging.getLogger(__name__)


class RequestMapper:
    """
    Thread-safe request ID mapping service.

    Two-tier indexing:
      _global_id_index  — PRIMARY.  Maps every known ID (frontend, correlation,
                          backend) directly to the canonical backend_id.  O(1).
                          Used by resolve_backend_id().
      _client_request_map — AUXILIARY.  Per-client subset of the same mappings.
                            Used only for bulk cleanup when a client disconnects.
      _backend_request_index — Reverse index from backend_id to metadata
                               (client_id, frontend_id, correlation_id).
    """

    def __init__(self):
        """Initialize request mapper."""
        # PRIMARY: any_id → backend_id  (global, cross-client)
        self._global_id_index: Dict[str, str] = {}
        # AUXILIARY: client_id → {any_id → backend_id}  (for disconnect cleanup)
        self._client_request_map: Dict[str, Dict[str, str]] = defaultdict(dict)
        # REVERSE: backend_id → {client_id, frontend_id, correlation_id}
        self._backend_request_index: Dict[str, Dict[str, Optional[str]]] = {}
        self._lock = asyncio.Lock()
        self._logger = logger

    async def register_mapping(
        self,
        *,
        client_id: str,
        frontend_id: Optional[str],
        correlation_id: Optional[str],
        backend_id: str,
    ) -> bool:
        """
        Register frontend→backend request mapping.

        Populates both the global index and the per-client map.

        Returns:
            True if registered, False if duplicate detected.
        """
        async with self._lock:
            mapping_keys = {backend_id}
            if frontend_id:
                mapping_keys.add(frontend_id)
            if correlation_id:
                mapping_keys.add(correlation_id)

            # Duplicate detection: check global index
            for key in mapping_keys:
                existing = self._global_id_index.get(key)
                if existing is not None and existing != backend_id:
                    self._logger.warning(
                        "Duplicate message detected - key=%s already mapped to backend_id=%s",
                        key,
                        existing,
                    )
                    return False

            # Write to global index (primary)
            for key in mapping_keys:
                self._global_id_index[key] = backend_id

            # Write to per-client map (auxiliary, for disconnect cleanup)
            for key in mapping_keys:
                self._client_request_map[client_id][key] = backend_id

            # Write to reverse index
            self._backend_request_index[backend_id] = {
                "client_id": client_id,
                "frontend_id": frontend_id,
                "correlation_id": correlation_id,
            }

            self._logger.info(
                "Registered mapping: client=%s, frontend=%s, backend=%s",
                client_id[:8] if client_id else "?",
                frontend_id[:8] if frontend_id else "?",
                backend_id[:8] if backend_id else "?",
            )

            return True

    async def resolve_backend_id(
        self,
        client_id: str,
        request_id: str,
    ) -> str:
        """
        Resolve backend ID from any known ID (frontend, correlation, or backend).

        Uses the global index — works regardless of which WebSocket client
        sent the request.  The client_id parameter is accepted for interface
        compatibility but is NOT used for scoping.

        Returns:
            Canonical backend request ID, or the input unchanged if unknown.
        """
        async with self._lock:
            resolved = self._global_id_index.get(request_id, request_id)
            if resolved != request_id:
                self._logger.info(
                    "Resolved ID: %s → %s (from client %s)",
                    request_id[:8],
                    resolved[:8],
                    client_id[:8] if client_id else "?",
                )
            return resolved

    async def forget_mapping(
        self,
        *,
        client_id: str,
        frontend_id: Optional[str],
        correlation_id: Optional[str] = None,
        backend_id: str,
    ) -> None:
        """
        Remove request mapping on completion.

        Cleans both global index and per-client map.
        """
        async with self._lock:
            lookup = self._backend_request_index.get(backend_id, {})
            stored_frontend_id = lookup.get("frontend_id")
            stored_correlation_id = lookup.get("correlation_id")
            stored_client_id = lookup.get("client_id") or client_id

            keys_to_remove = {backend_id}
            if frontend_id:
                keys_to_remove.add(frontend_id)
            if correlation_id:
                keys_to_remove.add(correlation_id)
            if stored_frontend_id:
                keys_to_remove.add(stored_frontend_id)
            if stored_correlation_id:
                keys_to_remove.add(stored_correlation_id)

            # Clean global index
            for key in keys_to_remove:
                self._global_id_index.pop(key, None)

            # Clean per-client map (use stored client_id, not the caller's)
            client_map = self._client_request_map.get(stored_client_id)
            if client_map:
                for key in keys_to_remove:
                    client_map.pop(key, None)
                if not client_map:
                    self._client_request_map.pop(stored_client_id, None)

            # Clean reverse index
            self._backend_request_index.pop(backend_id, None)

            self._logger.debug(
                "Forgot mapping: client=%s, frontend=%s, backend=%s",
                stored_client_id[:8] if stored_client_id else "?",
                frontend_id[:8] if frontend_id else "?",
                backend_id[:8] if backend_id else "?",
            )

    async def cleanup_client_mappings(self, client_id: str) -> None:
        """
        Remove all mappings for a disconnected client.

        Cleans both the per-client map and the corresponding global entries.
        """
        async with self._lock:
            # Get all mappings for this client
            client_map = self._client_request_map.pop(client_id, {})

            # Collect unique backend_ids to clean from reverse index
            backend_ids_to_remove = set(client_map.values())

            # Clean global index: remove every key that pointed to these backend_ids
            for key in list(client_map.keys()):
                self._global_id_index.pop(key, None)

            # Clean reverse index
            for backend_id in backend_ids_to_remove:
                self._backend_request_index.pop(backend_id, None)

            if client_map:
                self._logger.info(
                    "Cleaned up %d mappings for client %s",
                    len(client_map),
                    client_id[:8],
                )

