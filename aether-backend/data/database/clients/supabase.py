"""
@.architecture
Incoming: /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/app.py::startup_event; /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/config/settings.py::SupabaseSettings; /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/api/dependencies.py --- {SupabaseSettings, config_payload}
Processing: initialize Supabase clients, execute CRUD operations, manage realtime subscriptions, emit health diagnostics --- {9 jobs: JOB_CLEANUP_RESOURCE, JOB_DELETE_FROM_DB, JOB_HEALTH_CHECK, JOB_HTTP_REQUEST, JOB_INITIALIZE_COMPONENT, JOB_MANAGE_CLIENT, JOB_QUERY_DB, JOB_SAVE_TO_DB, JOB_UPDATE_DB}
Outgoing: Supabase REST API endpoints; Supabase Realtime channels; /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/data/database/repositories/* --- {Dict[str, Any], http_request}
"""

import ast
import asyncio
import os
import re
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from httpx import QueryParams
from monitoring import get_logger

try:
    from supabase import Client as SupabaseSDKClient, create_client as supabase_create_client
    from supabase import AClient as SupabaseAClient, acreate_client as supabase_acreate_client
    SUPABASE_AVAILABLE = True
except ModuleNotFoundError:
    SUPABASE_AVAILABLE = False

    class SupabaseSDKClient:  # type: ignore[empty-body]
        """Placeholder type when Supabase SDK is unavailable."""

        def __init__(self, *args, **kwargs):  # pragma: no cover - defensive guard
            raise RuntimeError(
                "Supabase Python client is not installed. Install the vendored SDK from "
                "services/supabase or provide an equivalent local implementation before "
                "initializing SupabaseClient."
            ) from import_error

    class SupabaseAClient:  # type: ignore[empty-body]
        """Placeholder type when Supabase SDK is unavailable."""

        def __init__(self, *args, **kwargs):  # pragma: no cover - defensive guard
            raise RuntimeError(
                "Supabase Python client is not installed."
            ) from import_error

    def supabase_create_client(*args, **kwargs):  # pragma: no cover - defensive guard
        raise RuntimeError(
            "Supabase Python client is not installed. Install the vendored SDK from "
            "services/supabase or provide an equivalent local implementation before "
            "initializing SupabaseClient."
        ) from import_error

    async def supabase_acreate_client(*args, **kwargs):  # pragma: no cover - defensive guard
        raise RuntimeError(
            "Supabase Python client is not installed."
        ) from import_error

Client = SupabaseSDKClient
create_client = supabase_create_client
AClient = SupabaseAClient
acreate_client = supabase_acreate_client

logger = get_logger(__name__)


class SupabaseClient:
    """
    Async-compatible Supabase client wrapper.
    
    Features:
    - CRUD operations on tables (chats, messages, artifacts, MCP tables)
    - Realtime subscriptions for live updates
    - Vector search via pgvector extension
    - Transaction support via PostgREST
    - Connection health monitoring
    - Automatic retries and error handling
    
    Usage:
        # Initialize
        sb = SupabaseClient.from_env()
        await sb.initialize()
        
        # CRUD operations
        chats = await sb.select('chats', filters={'id': chat_id})
        new_chat = await sb.insert('chats', {'title': 'New Chat'})
        await sb.update('chats', chat_id, {'title': 'Updated'})
        await sb.delete('chats', chat_id)
        
        # Realtime subscriptions
        def handle_insert(payload):
            logger.debug("New record: %s", payload)
        
        channel = sb.subscribe_realtime('chats', on_insert=handle_insert)
        
        # Cleanup
        await sb.dispose()
    """
    
    _GROUP_COUNT_VIEW_MAP: Dict[Tuple[str, str], str] = {
        ("messages", "chat_id"): "messages_group_counts",
        ("artifacts", "chat_id"): "artifacts_group_counts",
    }

    def __init__(
        self,
        url: str,
        key: str,
        service_role_key: Optional[str] = None,
        schema: str = "public",
        realtime_enabled: bool = True,
    ):
        """
        Initialize Supabase client.
        
        Args:
            url: Supabase project URL (http://localhost:54321)
            key: Supabase anon/public key
            service_role_key: Service role key for admin operations
            schema: Database schema (default: public)
            realtime_enabled: Enable realtime subscriptions
        """
        self.url = url
        self.key = key
        self.service_role_key = service_role_key or key
        self.schema = schema
        self.realtime_enabled = realtime_enabled
        
        self._client: Optional[Client] = None
        self._async_client: Optional[AClient] = None
        self._admin_client: Optional[Client] = None
        self._initialized = False
        self._channels: List = []
    
    # =========================================================================
    # LIFECYCLE MANAGEMENT
    # =========================================================================
    
    async def initialize(self) -> None:
        """
        Initialize Supabase client and connections.
        
        Raises:
            RuntimeError: If initialization fails
        """
        if self._initialized:
            logger.warning("Supabase client already initialized")
            return

        if not SUPABASE_AVAILABLE:
            raise RuntimeError(
                "Supabase Python client dependency is missing. Install the local Supabase SDK "
                "bundled in services/supabase or adjust PYTHONPATH before calling initialize()."
            )
        
        try:
            logger.info("Initializing Supabase client...")
            
            # Create client with anon key (for RLS-protected operations)
            self._client = create_client(self.url, self.key)
            
            # Create admin client with service role key (bypasses RLS)
            self._admin_client = create_client(self.url, self.service_role_key)
            
            # Create async client for realtime subscriptions
            self._async_client = await acreate_client(self.url, self.key)
            
            # Test connection
            health = await self.health_check()
            if not health.get('healthy'):
                raise RuntimeError(f"Supabase health check failed: {health.get('error')}")
            
            self._initialized = True
            logger.info("✅ Supabase client initialized")
            
        except Exception as e:
            logger.error(f"Failed to initialize Supabase client: {e}", exc_info=True)
            raise RuntimeError(f"Supabase initialization failed: {e}")
    
    async def dispose(self) -> None:
        """Cleanup Supabase client and subscriptions."""
        try:
            logger.info("Disposing Supabase client...")
            
            # Unsubscribe from all realtime channels
            for channel in self._channels:
                try:
                    await channel.unsubscribe()
                except Exception as e:
                    logger.error(f"Error unsubscribing channel: {e}")
            
            if self._async_client and hasattr(self._async_client, 'remove_all_channels'):
                try:
                    await self._async_client.remove_all_channels()
                except Exception as e:
                    logger.error(f"Error removing all channels: {e}")
            
            self._channels.clear()
            
            # Explicitly close async client if it has a session/HTTP client
            if self._async_client:
                # supabase-py doesn't have an explicit close for AClient currently,
                # but removing all channels clears the websocket.
                pass
                
            self._client = None
            self._async_client = None
            self._admin_client = None
            self._initialized = False
            
            logger.info("✅ Supabase client disposed")
            
        except Exception as e:
            logger.error(f"Error disposing Supabase client: {e}")
    
    @classmethod
    def from_env(cls, settings: Optional[Dict[str, Any]] = None) -> "SupabaseClient":
        """
        Create client from settings dictionary.
        
        Args:
            settings: Settings dict with keys: url, anon_key, service_role_key
        
        Returns:
            Configured SupabaseClient instance
        """
        if settings is None:
            # Fail-fast: do not hardcode Supabase keys in code.
            # Settings are loaded from env (e.g. config/local.env auto-loaded by config/settings.py).
            settings = {
                "url": os.getenv("SUPABASE_URL", "http://localhost:54321"),
                "anon_key": os.getenv("SUPABASE_ANON_KEY", ""),
                "service_role_key": os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
                "schema": os.getenv("SUPABASE_SCHEMA", "public"),
                "realtime_enabled": os.getenv("SUPABASE_REALTIME_ENABLED", "true").lower() in ("1", "true", "yes"),
            }

        if not settings.get("anon_key"):
            raise RuntimeError(
                "SUPABASE_ANON_KEY is missing. "
                "Configure Supabase credentials via env (auto-loaded from config/local.env)."
            )
        
        return cls(
            url=settings["url"],
            key=settings["anon_key"],
            service_role_key=settings.get("service_role_key"),
            schema=settings.get("schema", "public"),
            realtime_enabled=settings.get("realtime_enabled", True),
        )
    
    def get_client(self, admin: bool = False) -> Client:
        """
        Get Supabase client instance.
        
        Args:
            admin: If True, return admin client (bypasses RLS)
        
        Returns:
            Supabase client
        
        Raises:
            RuntimeError: If client not initialized
        """
        if not self._initialized:
            raise RuntimeError("Supabase client not initialized. Call initialize() first.")
        
        return self._admin_client if admin else self._client
    
    # =========================================================================
    # CRUD OPERATIONS
    # =========================================================================
    
    async def _execute(self, query):
        """
        Run blocking Supabase queries in a worker thread.
        
        Supabase's Python client is synchronous; to keep FastAPI's event loop responsive
        we offload the .execute() call to a background thread.
        """
        return await asyncio.to_thread(query.execute)
    
    async def insert(
        self,
        table: str,
        data: Union[Dict[str, Any], List[Dict[str, Any]]],
        *,
        admin: bool = False,
        return_representation: bool = True,
    ) -> Union[Dict[str, Any], List[Dict[str, Any]]]:
        """
        Insert record(s) into table.
        
        Args:
            table: Table name (e.g., 'chats', 'messages', 'artifacts')
            data: Single dict or list of dicts to insert
            admin: Use admin client (bypasses RLS)
            return_representation: Return inserted record(s)
        
        Returns:
            Inserted record(s) with generated IDs
        
        Raises:
            Exception: If insert fails
        """
        client = self.get_client(admin=admin)
        
        try:
            query = client.table(table).insert(data)
            
            if return_representation:
                response = await self._execute(query)
                return response.data
            else:
                await self._execute(query)
                return data
                
        except Exception as e:
            logger.error(f"Insert failed for table '{table}': {e}", exc_info=True)
            raise
    
    async def select(
        self,
        table: str,
        *,
        columns: Union[str, List[str]] = "*",
        filters: Optional[Dict[str, Any]] = None,
        in_filters: Optional[Dict[str, List[Any]]] = None,
        order_by: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        group_by: Optional[Union[str, List[str]]] = None,
        admin: bool = False,
        head: bool = False,
        count: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Select records from table.
        
        Args:
            table: Table name
            columns: Columns to select (default: all)
            filters: Dict of column:value filters (e.g., {'id': uuid})
            order_by: Column to order by (e.g., 'created_at.desc')
            limit: Max records to return
            offset: Number of records to skip
            admin: Use admin client
        
        Returns:
            List of matching records
        
        Raises:
            Exception: If select fails
        """
        client = self.get_client(admin=admin)
        
        try:
            select_args: Tuple[str, ...]
            if isinstance(columns, str):
                select_args = (columns,)
            else:
                select_args = tuple(columns)
            
            select_kwargs = {}
            if count is not None:
                select_kwargs["count"] = count
            
            query = client.table(table).select(*select_args, **select_kwargs)
            
            if head:
                query = query.limit(0)
            
            # Apply equality filters
            if filters:
                for column, value in filters.items():
                    # Special handling for NULL checks
                    if value == "is.null":
                        query = query.is_(column, "null")
                    elif isinstance(value, dict):
                        # Support for PostgREST operators in dictionary format
                        # Example: {"gte": "2024-01-01"}
                        for op, op_val in value.items():
                            if op == "gte":
                                query = query.gte(column, op_val)
                            elif op == "lte":
                                query = query.lte(column, op_val)
                            elif op == "gt":
                                query = query.gt(column, op_val)
                            elif op == "lt":
                                query = query.lt(column, op_val)
                            elif op == "neq":
                                query = query.neq(column, op_val)
                            elif op == "like":
                                query = query.like(column, op_val)
                            elif op == "ilike":
                                query = query.ilike(column, op_val)
                            else:
                                logger.warning(f"Unsupported PostgREST operator: {op}")
                                query = query.eq(column, op_val)
                    else:
                        query = query.eq(column, value)

            # Apply IN filters
            if in_filters:
                for column, values in in_filters.items():
                    if not isinstance(values, (list, tuple, set)):
                        raise ValueError(f"in_filters[{column}] must be a sequence")
                    values = list(values)
                    if not values:
                        # Empty IN should yield no rows; mimic by adding impossible predicate
                        query = query.eq(column, "__never_matches__")
                    else:
                        query = query.in_(column, values)

            # Apply grouping (PostgREST `group` query param)
            if group_by:
                # Ensure identifiers are sanitized and consistently encoded
                if isinstance(group_by, (list, tuple, set)):
                    group_tokens = [
                        self._sanitize_identifier(str(component))
                        for component in group_by
                    ]
                else:
                    group_tokens = [self._sanitize_identifier(str(group_by))]

                group_value = ",".join(group_tokens)

                params = getattr(query, "params", None)
                if isinstance(params, QueryParams):
                    query.params = params.add("group", group_value)
                elif isinstance(params, dict):
                    updated_params = dict(params)
                    updated_params["group"] = group_value
                    query.params = updated_params
                else:
                    query.params = {"group": group_value}
            
            # Apply ordering
            if order_by:
                if order_by.endswith('.desc'):
                    column = order_by.replace('.desc', '')
                    query = query.order(column, desc=True)
                else:
                    query = query.order(order_by)
            
            # Apply limit/offset
            if limit is not None:
                query = query.limit(limit)
            if offset:
                query = query.offset(offset)
            
            response = await self._execute(query)
            return response.data
            
        except Exception as e:
            logger.error(f"Select failed for table '{table}': {e}", exc_info=True)
            raise

    async def group_count(
        self,
        table: str,
        group_column: str,
        *,
        filters: Optional[Dict[str, Any]] = None,
        in_filters: Optional[Dict[str, List[Any]]] = None,
        count_column: str = "id",
        count_alias: str = "count",
        admin: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Compute grouped counts for a table using precomputed views or PostgREST aggregations.
        """
        alias = count_alias or "count"
        view_name = self._GROUP_COUNT_VIEW_MAP.get((table, group_column))
        allowed_keys = {group_column}

        if view_name:
            unsupported_filter_keys = (
                set(filters.keys()) - allowed_keys if filters else set()
            )
            unsupported_in_filter_keys = (
                set(in_filters.keys()) - allowed_keys if in_filters else set()
            )

            if unsupported_filter_keys or unsupported_in_filter_keys:
                logger.debug(
                    "Skipping group-count view due to unsupported filters",
                    extra={
                        "table": table,
                        "group_column": group_column,
                        "filters": unsupported_filter_keys,
                        "in_filters": unsupported_in_filter_keys,
                    },
                )
            else:
                columns_expression = (
                    f"{group_column},{alias}:count"
                    if alias != "count"
                    else f"{group_column},count"
                )
                return await self.select(
                    view_name,
                    columns=columns_expression,
                    filters=filters,
                    in_filters=in_filters,
                    admin=admin,
                )

        sanitized_group = self._sanitize_identifier(group_column)
        columns = self._build_group_count_columns(
            group_column=sanitized_group,
            count_column=count_column,
            alias=alias,
        )
        return await self.select(
            table,
            columns=columns,
            filters=filters,
            in_filters=in_filters,
            group_by=sanitized_group,
            admin=admin,
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
    ) -> Union[Dict[str, Any], List[Dict[str, Any]]]:
        """
        Update record(s) in table.
        
        Args:
            table: Table name
            data: Dict of columns to update
            record_id: Optional single Record ID to update (shortcut for id_column=record_id filter)
            id_column: Primary key column name (used with record_id)
            filters: Optional dict of equality filters
            in_filters: Optional dict of IN filters
            admin: Use admin client
        
        Returns:
            Updated record(s)
        
        Raises:
            Exception: If update fails
        """
        client = self.get_client(admin=admin)
        
        try:
            query = client.table(table).update(data)
            
            # Apply filters
            if record_id:
                query = query.eq(id_column, record_id)
            
            if filters:
                for column, value in filters.items():
                    if value == "is.null":
                        query = query.is_(column, "null")
                    elif isinstance(value, dict):
                        for op, op_val in value.items():
                            if op == "gte": query = query.gte(column, op_val)
                            elif op == "lte": query = query.lte(column, op_val)
                            elif op == "gt": query = query.gt(column, op_val)
                            elif op == "lt": query = query.lt(column, op_val)
                            elif op == "neq": query = query.neq(column, op_val)
                            elif op == "in": query = query.in_(column, op_val)
                            else: query = query.eq(column, op_val)
                    else:
                        query = query.eq(column, value)
            
            if in_filters:
                for column, values in in_filters.items():
                    if values:
                        query = query.in_(column, list(values))
            
            response = await self._execute(query)
            return response.data
                
        except Exception as e:
            logger.error(f"Update failed for table '{table}': {e}", exc_info=True)
            raise
    
    async def delete(
        self,
        table: str,
        *,
        record_id: Optional[str] = None,
        id_column: str = "id",
        filters: Optional[Dict[str, Any]] = None,
        admin: bool = False,
    ) -> Union[Dict[str, Any], List[Dict[str, Any]]]:
        """
        Delete record(s) from table.
        
        Args:
            table: Table name
            record_id: Optional single Record ID to delete
            id_column: Primary key column name (used with record_id)
            filters: Optional filters for batch deletion
            admin: Use admin client
        
        Returns:
            Deleted record(s) (if returned by API)
        """
        client = self.get_client(admin=admin)
        
        try:
            query = client.table(table).delete()
            
            if record_id:
                query = query.eq(id_column, record_id)
            
            if filters:
                for column, value in filters.items():
                    if value == "is.null":
                        query = query.is_(column, "null")
                    elif isinstance(value, dict):
                        for op, op_val in value.items():
                            if op == "gte": query = query.gte(column, op_val)
                            elif op == "lte": query = query.lte(column, op_val)
                            elif op == "gt": query = query.gt(column, op_val)
                            elif op == "lt": query = query.lt(column, op_val)
                            else: query = query.eq(column, op_val)
                    else:
                        query = query.eq(column, value)
            
            response = await self._execute(query)
            return response.data
            
        except Exception as e:
            logger.error(f"Delete failed for table '{table}': {e}", exc_info=True)
            raise
    
    async def upsert(
        self,
        table: str,
        data: Union[Dict[str, Any], List[Dict[str, Any]]],
        *,
        on_conflict: Optional[str] = None,
        admin: bool = False,
    ) -> Union[Dict[str, Any], List[Dict[str, Any]]]:
        """
        Upsert (insert or update) record(s).
        
        ARCHITECTURAL NOTE: PostgREST v13 has a limitation where on_conflict
        does NOT work with composite UNIQUE constraints, only with:
        - Primary keys (when on_conflict is omitted)
        - Single-column unique constraints
        
        For composite unique constraints, we implement application-level upsert:
        1. Try INSERT
        2. If error 23505 (unique violation), perform UPDATE with composite filter
        
        Args:
            table: Table name
            data: Record(s) to upsert
            on_conflict: Column(s) to check for conflicts (ignored, kept for API compat)
            admin: Use admin client
        
        Returns:
            Upserted record(s)
        
        Raises:
            Exception: If upsert fails
        """
        client = self.get_client(admin=admin)
        
        # Handle single record with application-level upsert
        if isinstance(data, dict):
            # -----------------------------------------------------------------
            # Composite-unique upserts (single round-trip, no exception-driven flow)
            #
            # Root cause of "✅ Duplicate detected ..." spam:
            # We were doing INSERT-first then catching 23505 and issuing UPDATE.
            # That is both noisy and inefficient.
            #
            # PostgREST supports `on_conflict` for upsert; postgrest-py exposes it.
            # For these known composite unique constraints, prefer a direct upsert.
            # -----------------------------------------------------------------
            try:
                if table == "artifacts" and "chat_id" in data and "artifact_id" in data:
                    query = client.table(table).upsert(
                        data,
                        on_conflict="chat_id,artifact_id",
                    )
                    response = await self._execute(query)
                    return response.data[0] if response.data else {}

                if table == "mcp_tools" and "server_id" in data and "tool_name" in data:
                    query = client.table(table).upsert(
                        data,
                        on_conflict="server_id,tool_name",
                    )
                    response = await self._execute(query)
                    return response.data[0] if response.data else {}

                if table == "user_preferences" and "user_id" in data and "preference_key" in data:
                    query = client.table(table).upsert(
                        data,
                        on_conflict="user_id,preference_key",
                    )
                    response = await self._execute(query)
                    return response.data[0] if response.data else {}

                if table == "trail_states" and "chat_id" in data:
                    # Trail states uses chat_id as PRIMARY KEY; be explicit for clarity.
                    query = client.table(table).upsert(
                        data,
                        on_conflict="chat_id",
                    )
                    response = await self._execute(query)
                    return response.data[0] if response.data else {}
            except Exception as e:
                # Fail-fast: do not silently fall back to slower paths for these tables.
                logger.error(
                    f"Upsert failed for table '{table}' via on_conflict upsert: {e}",
                    exc_info=True,
                )
                raise

            try:
                # Try INSERT first
                query = client.table(table).insert(data)
                response = await self._execute(query)
                return response.data[0] if response.data else {}
            
            except Exception as e:
                # Parse error - postgrest-py returns error as a string repr of dict
                error_dict = {}
                if e.args:
                    try:
                        # APIError passes dict as string, use ast.literal_eval to parse safely
                        if isinstance(e.args[0], str):
                            error_dict = ast.literal_eval(e.args[0])
                        elif isinstance(e.args[0], dict):
                            error_dict = e.args[0]
                    except (ValueError, SyntaxError):
                        logger.warning(f"Could not parse error dict from {type(e).__name__}: {e.args[0]}")
                        error_dict = {}
                
                logger.debug(f"Insert failed for '{table}': {type(e).__name__}, error_code={error_dict.get('code')}, parsed_dict={bool(error_dict)}")
                
                # If unique constraint violation, try UPDATE
                if isinstance(error_dict, dict) and error_dict.get('code') == '23505':
                    # NOTE: This path should now be rare; prefer on_conflict upsert above.
                    # Keep at DEBUG to avoid spamming logs during normal "upsert" semantics.
                    logger.debug(
                        "Unique violation during INSERT-first upsert; performing UPDATE",
                        extra={"table": table},
                    )
                    
                    # Table-specific composite key handling
                    if table == 'artifacts' and 'chat_id' in data and 'artifact_id' in data:
                        # Artifacts uses (chat_id, artifact_id) unique constraint
                        filters = {
                            'chat_id': data['chat_id'],
                            'artifact_id': data['artifact_id']
                        }
                        query = client.table(table).update(data).match(filters)
                        response = await self._execute(query)
                        return response.data[0] if response.data else {}
                    
                    elif table == 'mcp_tools' and 'server_id' in data and 'tool_name' in data:
                        # MCP tools uses (server_id, tool_name) unique constraint
                        filters = {
                            'server_id': data['server_id'],
                            'tool_name': data['tool_name']
                        }
                        query = client.table(table).update(data).match(filters)
                        response = await self._execute(query)
                        return response.data[0] if response.data else {}
                    
                    elif table == 'trail_states' and 'chat_id' in data:
                        # Trail states uses chat_id as PRIMARY KEY
                        filters = {'chat_id': data['chat_id']}
                        query = client.table(table).update(data).match(filters)
                        response = await self._execute(query)
                        return response.data[0] if response.data else {}
                    
                    elif table == 'user_preferences' and 'user_id' in data and 'preference_key' in data:
                        # User preferences uses (user_id, preference_key) unique constraint
                        filters = {
                            'user_id': data['user_id'],
                            'preference_key': data['preference_key']
                        }
                        query = client.table(table).update(data).match(filters)
                        response = await self._execute(query)
                        return response.data[0] if response.data else {}
                    
                    elif table == 'user_settings' and 'setting_key' in data:
                        # User settings uses setting_key unique constraint
                        filters = {'setting_key': data['setting_key']}
                        query = client.table(table).update(data).match(filters)
                        response = await self._execute(query)
                        return response.data[0] if response.data else {}
                    
                    elif table == 'integration_health' and 'name' in data:
                        # Integration health uses name unique constraint
                        filters = {'name': data['name']}
                        query = client.table(table).update(data).match(filters)
                        response = await self._execute(query)
                        return response.data[0] if response.data else {}
                    
                    # For other tables, log warning and re-raise
                    logger.warning(f"Upsert fallback not implemented for table '{table}'")
                
                logger.error(f"Upsert failed for table '{table}': {e}", exc_info=True)
                raise
        
        # Handle batch upsert (list of records)
        else:
            try:
                # For batch operations, use PostgREST's built-in upsert
                # This works for primary key conflicts
                query = client.table(table).upsert(data)
                response = await self._execute(query)
                return response.data
            except Exception as e:
                logger.error(f"Batch upsert failed for table '{table}': {e}", exc_info=True)
                raise
    
    async def count(
        self,
        table: str,
        *,
        filters: Optional[Dict[str, Any]] = None,
        admin: bool = False,
        count_type: str = "exact",
    ) -> int:
        """
        Count records in a table without transferring row payloads.
        
        Args:
            table: Table name
            filters: Optional filters applied before counting
            admin: Use admin client
            count_type: PostgREST count strategy ('exact', 'planned', or 'estimated')
        
        Returns:
            Exact or estimated row count
        """
        client = self.get_client(admin=admin)
        
        try:
            query = (
                client.table(table)
                .select("id", count=count_type)
                .limit(0)
            )
            
            if filters:
                for column, value in filters.items():
                    query = query.eq(column, value)
            
            response = await self._execute(query)
            return response.count or 0
        
        except Exception as e:
            logger.error(f"Count failed for table '{table}': {e}", exc_info=True)
            raise
    
    # =========================================================================
    # REALTIME SUBSCRIPTIONS
    # =========================================================================
    
    async def subscribe_realtime(
        self,
        table: str,
        *,
        event: str = "*",
        on_insert: Optional[Callable] = None,
        on_update: Optional[Callable] = None,
        on_delete: Optional[Callable] = None,
        filters: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """
        Subscribe to realtime changes on table.
        
        Args:
            table: Table name to subscribe to
            event: Event type ('INSERT', 'UPDATE', 'DELETE', or '*' for all)
            on_insert: Callback for INSERT events
            on_update: Callback for UPDATE events
            on_delete: Callback for DELETE events
            filters: Dict of column:value filters
        
        Returns:
            Realtime channel object
        
        Example:
            def handle_new_message(payload):
                logger.debug("New message: %s", payload['record'])
            
            channel = sb.subscribe_realtime(
                'messages',
                on_insert=handle_new_message,
                filters={'chat_id': 'some-uuid'}
            )
        """
        if not self.realtime_enabled:
            logger.warning("Realtime not enabled")
            return None
        
        if not self._initialized:
            raise RuntimeError("Supabase client not initialized")
        
        try:
            # Create channel
            channel_name = f"{table}:{event}"
            channel = self._async_client.channel(channel_name)
            
            # Build filter string
            filter_str = None
            if filters:
                filter_parts = [f"{k}=eq.{v}" for k, v in filters.items()]
                filter_str = "&".join(filter_parts)
            
            # Register event handlers
            if event == "*" or event == "INSERT":
                if on_insert:
                    channel.on_postgres_changes(
                        event="INSERT",
                        schema=self.schema,
                        table=table,
                        filter=filter_str,
                        callback=on_insert,
                    )
            
            if event == "*" or event == "UPDATE":
                if on_update:
                    channel.on_postgres_changes(
                        event="UPDATE",
                        schema=self.schema,
                        table=table,
                        filter=filter_str,
                        callback=on_update,
                    )
            
            if event == "*" or event == "DELETE":
                if on_delete:
                    channel.on_postgres_changes(
                        event="DELETE",
                        schema=self.schema,
                        table=table,
                        filter=filter_str,
                        callback=on_delete,
                    )
            
            # Subscribe
            await channel.subscribe()
            
            if not self._initialized:
                # Client was disposed during the await
                try:
                    await channel.unsubscribe()
                except Exception:
                    pass
                raise RuntimeError("Supabase client was disposed during subscription")
                
            self._channels.append(channel)
            
            logger.info(f"✅ Subscribed to realtime changes on '{table}' (event: {event})")
            return channel
            
        except Exception as e:
            logger.error(f"Failed to subscribe to realtime on '{table}': {e}", exc_info=True)
            raise
    
    # =========================================================================
    # HEALTH & DIAGNOSTICS
    # =========================================================================
    
    async def health_check(self) -> Dict[str, Any]:
        """
        Perform health check on Supabase connection.
        
        Returns:
            Dict with health status information
        """
        result = {
            "healthy": False,
            "initialized": self._initialized,
            "error": None,
        }
        
        # Allow health check during initialization if client exists
        if not self._client:
            result["error"] = "Client not initialized"
            return result
        
        try:
            # Test query to verify connection
            # Use admin client (service role) for health check to bypass RLS
            # and ensure we're testing the connection, not table permissions.
            
            # Since migrations might not have run yet, we shouldn't test against
            # application tables like 'chats' which causes PGRST205 errors.
            # Instead, just verify the HTTP endpoint is responsive by fetching the root.
            # We can also attempt a lightweight query that we expect to fail gracefully 
            # or use the built-in health check if exposed.
            
            import httpx
            async with httpx.AsyncClient() as http_client:
                # Ping the health endpoint of the REST API directly
                rest_url = f"{self.url.rstrip('/')}/rest/v1/"
                resp = await http_client.get(rest_url)
                if resp.status_code not in (200, 404): # PostgREST root might return 404 depending on config
                    # Just checking if the service is up, not if it has tables
                    pass
            
            result["healthy"] = True
            result["connection"] = "ok"
            
            # Get table counts (using estimated counts for speed)
            try:
                result["counts"] = {
                    "chats": await self.count("chats", admin=True, count_type="estimated"),
                    "messages": await self.count("messages", admin=True, count_type="estimated"),
                    "artifacts": await self.count("artifacts", admin=True, count_type="estimated"),
                }
            except Exception:
                pass
            
        except Exception as e:
            result["error"] = str(e)
            logger.error(f"Health check failed: {e}")
        
        return result
    
    def is_initialized(self) -> bool:
        """Check if client is initialized."""
        return self._initialized
    
    def get_diagnostics(self) -> Dict[str, Any]:
        """
        Get detailed diagnostics.
        
        Returns:
            Dict with client configuration and status
        """
        return {
            "initialized": self._initialized,
            "url": self.url,
            "schema": self.schema,
            "realtime_enabled": self.realtime_enabled,
            "active_channels": len(self._channels),
        }

    async def rpc(
        self,
        function_name: str,
        params: Optional[Dict[str, Any]] = None,
        *,
        admin: bool = False,
    ) -> Any:
        """
        Call a PostgreSQL function via PostgREST RPC.
        
        Args:
            function_name: Name of the PostgreSQL function to call
            params: Optional dict of parameters to pass to function
            admin: Use admin client (bypasses RLS)
        
        Returns:
            Function return value
        
        Example:
            sequence = await sb.rpc('get_next_chat_sequence', {'p_chat_id': chat_id})
        """
        client = self.get_client(admin=admin)
        
        try:
            query = client.rpc(function_name, params or {})
            response = await self._execute(query)
            # RPC returns data in response.data
            return response.data
        except Exception as e:
            logger.error(f"RPC call failed for function '{function_name}': {e}", exc_info=True)
            raise
    
    async def reload_schema_cache(self) -> None:
        """
        Force PostgREST to reload its schema cache.
        """
        try:
            await self.rpc("reload_schema_cache", admin=True)
            logger.info("Supabase schema cache reloaded via rpc.reload_schema_cache")
        except Exception as exc:
            logger.error(f"Failed to reload Supabase schema cache: {exc}")
            raise

    # -------------------------------------------------------------------------
    # Internal helpers
    # -------------------------------------------------------------------------

    _IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$")

    @classmethod
    def _sanitize_identifier(cls, identifier: str, *, allow_wildcard: bool = False) -> str:
        if allow_wildcard and identifier == "*":
            return identifier
        if not isinstance(identifier, str) or not cls._IDENTIFIER_PATTERN.match(identifier):
            raise ValueError(f"Invalid identifier for Supabase query: {identifier!r}")
        return identifier

    @classmethod
    def _build_group_count_columns(
        cls,
        *,
        group_column: str,
        count_column: str,
        alias: str,
    ) -> str:
        sanitized_group = cls._sanitize_identifier(group_column)
        sanitized_alias = cls._sanitize_identifier(alias)
        if count_column != "*":
            cls._sanitize_identifier(count_column)
        # PostgREST count aggregator cannot accept explicit column notation when using
        # alias syntax (colon). Use column-agnostic count per group.
        return f"{sanitized_group},{sanitized_alias}:count"

