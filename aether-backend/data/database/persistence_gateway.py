"""
@.architecture
Incoming: /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/api/dependencies.py::get_database; /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/data/database/repositories/*.py --- {SupabaseClient, repository_command}
Processing: orchestrate Supabase operations with retry + telemetry, sanitize query identifiers, emit correlation-aware diagnostics --- {JOB_QUERY_DB, JOB_RETRY, JOB_SAVE_TO_DB, JOB_UPDATE_DB}
Outgoing: Supabase REST API endpoints; /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/data/database/repositories/*.py --- {Dict[str, Any], supabase_response}
"""

from __future__ import annotations

import asyncio
import re
import uuid
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, Sequence, Tuple, Union

try:
    from postgrest.exceptions import APIError  # type: ignore[attr-defined]
except ModuleNotFoundError:
    class APIError(Exception):
        """Lightweight fallback when PostgREST client is unavailable."""

        def __init__(
            self,
            message: str = "",
            *,
            code: Optional[str] = None,
            details: Optional[str] = None,
        ) -> None:
            super().__init__(message)
            self.code = code
            self.details = details
            self.message = message

from monitoring.logging import get_correlation_id, get_logger
from .clients.supabase import SupabaseClient
from .concurrency import RetryableError, with_retry


AsyncFactory = Callable[[], Awaitable[Any]]


class SupabasePersistenceGateway:
    """
    Reliability-focused facade around `SupabaseClient`.

    Adds:
    - Exponential backoff with transient error classification
    - Identifier sanitisation for PostgREST queries
    - Correlation-aware structured logging
    """

    _IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$")

    def __init__(
        self,
        client: SupabaseClient,
        *,
        max_retries: int = 3,
        backoff_factor: float = 2.0,
        initial_delay: float = 0.25,
    ) -> None:
        self._client = client
        self._logger = get_logger(__name__)
        self._max_retries = max_retries
        self._backoff_factor = backoff_factor
        self._initial_delay = initial_delay
        self._retryable_postgrest_codes = {
            "",          # Gateway proxy empty response / booting
            "PGRST116",  # Communication timeout
            "PGRST204",  # Connection unexpectedly terminated
            "PGRST308",  # Resource exhausted
            "PGRST310",  # Statement timeout
            "57014",     # PostgreSQL statement timeout (query_canceled)
        }
        self._retryable_exceptions = (
            RetryableError,
            ConnectionError,
            TimeoutError,
            asyncio.TimeoutError,
        )
        self._schema_cache_reload_in_progress = False

    # --------------------------------------------------------------------- #
    # Lifecycle delegation
    # --------------------------------------------------------------------- #

    async def initialize(self) -> None:
        await self._client.initialize()

    async def dispose(self) -> None:
        await self._client.dispose()

    def is_initialized(self) -> bool:
        return self._client.is_initialized()

    async def health_check(self) -> Dict[str, Any]:
        return await self._client.health_check()

    def get_diagnostics(self) -> Dict[str, Any]:
        return self._client.get_diagnostics()

    @property
    def raw_client(self) -> SupabaseClient:
        """Expose underlying client for advanced scenarios (read-only)."""
        return self._client

    # --------------------------------------------------------------------- #
    # Public data access methods
    # --------------------------------------------------------------------- #

    async def insert(
        self,
        table: str,
        data: Union[Dict[str, Any], List[Dict[str, Any]]],
        *,
        admin: bool = False,
        return_representation: bool = True,
        correlation_id: Optional[str] = None,
    ) -> Any:
        cid = self._resolve_correlation_id(correlation_id)
        return await self._run_with_retry(
            "insert",
            lambda: self._client.insert(
                table,
                data,
                admin=admin,
                return_representation=return_representation,
            ),
            correlation_id=cid,
            table=table,
            payload_size=self._payload_size(data),
        )

    async def select(
        self,
        table: str,
        *,
        columns: Union[str, List[str]] = "*",
        filters: Optional[Dict[str, Any]] = None,
        in_filters: Optional[Dict[str, Sequence[Any]]] = None,
        order_by: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        group_by: Optional[Union[str, Iterable[str]]] = None,
        admin: bool = False,
        head: bool = False,
        count: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        cid = self._resolve_correlation_id(correlation_id)
        sanitized_group = self._sanitize_group_by(group_by)
        return await self._run_with_retry(
            "select",
            lambda: self._client.select(
                table,
                columns=columns,
                filters=filters,
                in_filters=in_filters,
                order_by=order_by,
                limit=limit,
                offset=offset,
                group_by=sanitized_group,
                admin=admin,
                head=head,
                count=count,
            ),
            correlation_id=cid,
            table=table,
            limit=limit,
            group_by=sanitized_group,
        )

    async def update(
        self,
        table: str,
        data: Dict[str, Any],
        *,
        record_id: Optional[str] = None,
        id_column: str = "id",
        filters: Optional[Dict[str, Any]] = None,
        in_filters: Optional[Dict[str, List[Any]]] = None,
        admin: bool = False,
        correlation_id: Optional[str] = None,
    ) -> Union[Dict[str, Any], List[Dict[str, Any]]]:
        cid = self._resolve_correlation_id(correlation_id)
        return await self._run_with_retry(
            "update",
            lambda: self._client.update(
                table,
                data,
                record_id=record_id,
                id_column=id_column,
                filters=filters,
                in_filters=in_filters,
                admin=admin,
            ),
            correlation_id=cid,
            table=table,
            id_column=id_column,
        )

    async def delete(
        self,
        table: str,
        *,
        record_id: Optional[str] = None,
        id_column: str = "id",
        filters: Optional[Dict[str, Any]] = None,
        admin: bool = False,
        correlation_id: Optional[str] = None,
    ) -> Union[Dict[str, Any], List[Dict[str, Any]]]:
        cid = self._resolve_correlation_id(correlation_id)
        return await self._run_with_retry(
            "delete",
            lambda: self._client.delete(
                table,
                record_id=record_id,
                id_column=id_column,
                filters=filters,
                admin=admin,
            ),
            correlation_id=cid,
            table=table,
            id_column=id_column,
        )

    async def upsert(
        self,
        table: str,
        data: Union[Dict[str, Any], List[Dict[str, Any]]],
        *,
        admin: bool = False,
        correlation_id: Optional[str] = None,
    ) -> Any:
        cid = self._resolve_correlation_id(correlation_id)
        return await self._run_with_retry(
            "upsert",
            lambda: self._client.upsert(
                table,
                data,
                admin=admin,
            ),
            correlation_id=cid,
            table=table,
        )

    async def count(
        self,
        table: str,
        *,
        filters: Optional[Dict[str, Any]] = None,
        admin: bool = False,
        correlation_id: Optional[str] = None,
    ) -> int:
        cid = self._resolve_correlation_id(correlation_id)
        return await self._run_with_retry(
            "count",
            lambda: self._client.count(
                table,
                filters=filters,
                admin=admin,
            ),
            correlation_id=cid,
            table=table,
        )

    async def group_count(
        self,
        table: str,
        group_column: str,
        *,
        filters: Optional[Dict[str, Any]] = None,
        in_filters: Optional[Dict[str, Sequence[Any]]] = None,
        count_column: str = "id",
        count_alias: str = "count",
        admin: bool = False,
        correlation_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        cid = self._resolve_correlation_id(correlation_id)
        return await self._run_with_retry(
            "group_count",
            lambda: self._client.group_count(
                table,
                group_column,
                filters=filters,
                in_filters=in_filters,
                count_column=count_column,
                count_alias=count_alias,
                admin=admin,
            ),
            correlation_id=cid,
            table=table,
            group_by=group_column,
        )

    # --------------------------------------------------------------------- #
    # Delegated realtime support (unchanged)
    # --------------------------------------------------------------------- #

    async def subscribe_realtime(self, *args: Any, **kwargs: Any) -> Any:
        return await self._client.subscribe_realtime(*args, **kwargs)

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    async def _run_with_retry(
        self,
        operation: str,
        coroutine_factory: AsyncFactory,
        *,
        correlation_id: str,
        **log_context: Any,
    ) -> Any:
        attempt_counter = {"value": 0}

        async def wrapped() -> Any:
            attempt_counter["value"] += 1
            attempt = attempt_counter["value"]
            try:
                result = await coroutine_factory()
                if attempt == 1:
                    self._logger.debug(
                        f"Supabase {operation} succeeded",
                        correlation_id=correlation_id,
                        attempt=attempt,
                        **log_context,
                    )
                else:
                    self._logger.info(
                        f"Supabase {operation} recovered after retry",
                        correlation_id=correlation_id,
                        attempt=attempt,
                        **log_context,
                    )
                return result
            except APIError as api_error:
                message_text = (api_error.message or "").lower() if hasattr(api_error, "message") else str(api_error).lower()
                schema_cache_error = (
                    api_error.code == "PGRST204"
                    and "schema cache" in message_text
                )
                if schema_cache_error and not self._schema_cache_reload_in_progress:
                    self._schema_cache_reload_in_progress = True
                    try:
                        self._logger.warning(
                            "Supabase schema cache stale detected; reloading",
                            correlation_id=correlation_id,
                            attempt=attempt,
                            code=api_error.code,
                            details=api_error.details,
                            error_message=str(api_error),
                            **log_context,
                        )
                        await self._client.reload_schema_cache()
                    except Exception as reload_exc:
                        self._logger.error(
                            "Failed to reload Supabase schema cache",
                            correlation_id=correlation_id,
                            error=str(reload_exc),
                            **log_context,
                        )
                    finally:
                        self._schema_cache_reload_in_progress = False
                    raise RetryableError(str(api_error)) from api_error

                if api_error.code in self._retryable_postgrest_codes:
                    self._logger.warning(
                        f"Transient Supabase API error during {operation}",
                        correlation_id=correlation_id,
                        attempt=attempt,
                        code=api_error.code,
                        details=api_error.details,
                        error_message=str(api_error),
                        **log_context,
                    )
                    raise RetryableError(str(api_error)) from api_error
                self._logger.error(
                    f"Supabase API error during {operation}",
                    correlation_id=correlation_id,
                    attempt=attempt,
                    code=api_error.code,
                    details=api_error.details,
                    error_message=str(api_error),
                    **log_context,
                )
                raise
            except (asyncio.TimeoutError, ConnectionError, TimeoutError) as transient_error:
                self._logger.warning(
                    f"Supabase transport error during {operation}",
                    correlation_id=correlation_id,
                    attempt=attempt,
                    error=str(transient_error),
                    **log_context,
                )
                raise transient_error

        return await with_retry(
            wrapped,
            max_retries=self._max_retries,
            backoff_factor=self._backoff_factor,
            initial_delay=self._initial_delay,
            retryable_exceptions=self._retryable_exceptions,
        )

    @classmethod
    def _sanitize_identifier(cls, identifier: str, *, allow_wildcard: bool = False) -> str:
        if allow_wildcard and identifier == "*":
            return identifier
        if not cls._IDENTIFIER_PATTERN.match(identifier):
            raise ValueError(f"Invalid identifier for Supabase query: {identifier!r}")
        return identifier

    def _sanitize_group_by(
        self,
        group_by: Optional[Union[str, Iterable[str]]],
    ) -> Optional[Union[str, Tuple[str, ...]]]:
        if group_by is None:
            return None
        if isinstance(group_by, str):
            return self._sanitize_identifier(group_by)
        sanitized = tuple(self._sanitize_identifier(item) for item in group_by)
        return sanitized

    def _build_group_count_columns(
        self,
        *,
        group_column: str,
        count_column: str,
        alias: str,
    ) -> str:
        sanitized_group = self._sanitize_identifier(group_column)
        sanitized_alias = self._sanitize_identifier(alias)
        if count_column != "*":
            self._sanitize_identifier(count_column)
        return f"{sanitized_group},{sanitized_alias}:count"

    @staticmethod
    def _payload_size(payload: Union[Dict[str, Any], List[Dict[str, Any]]]) -> int:
        if isinstance(payload, list):
            return len(payload)
        return 1

    @staticmethod
    def _resolve_correlation_id(candidate: Optional[str]) -> str:
        if candidate:
            return candidate
        context_id = get_correlation_id()
        if context_id:
            return context_id
        return str(uuid.uuid4())

    def __getattr__(self, item: str) -> Any:
        """
        Fallback attribute delegation to underlying client for compatibility.
        """
        return getattr(self._client, item)

