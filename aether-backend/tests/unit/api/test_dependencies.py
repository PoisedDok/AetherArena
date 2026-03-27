"""
Unit tests for api/dependencies.py

Direct unit tests for dependency injection functions — settings resolution,
request locality enforcement, singleton getters/setters, database/cache plumbing,
authentication wiring, request context building, pagination, and service lifecycle.

CI: pytest tests/unit/api/test_dependencies.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock
from fastapi import HTTPException

import api.dependencies as deps
from core.system.connection_manager import ConnectionManager


# =============================================================================
# Helpers
# =============================================================================

def _make_request(
    client_host="127.0.0.1",
    host_header="localhost:8765",
    method="GET",
    path="/v1/test",
    headers=None,
):
    """Build a minimal mock Request with client, headers, state, and url."""
    req = MagicMock()
    req.client = MagicMock()
    req.client.host = client_host
    req.method = method

    url = MagicMock()
    url.path = path
    req.url = url

    _headers = {"host": host_header}
    if headers:
        _headers.update(headers)
    req.headers = _headers

    req.state = MagicMock()
    return req


def _make_settings(**overrides):
    """Build mock settings with security sub-object."""
    s = MagicMock()
    s.environment = overrides.get("environment", "test")
    s.security.default_user_id = overrides.get("default_user_id", "default_user")
    s.security.auth_enabled = overrides.get("auth_enabled", False)
    s.security.api_key_required = overrides.get("api_key_required", False)
    s.security.api_key_header = overrides.get("api_key_header", "X-API-Key")
    s.security.allow_bearer_tokens = overrides.get("allow_bearer_tokens", True)
    s.security.allow_anonymous = overrides.get("allow_anonymous", True)
    s.security.default_role = overrides.get("default_role", "user")
    s.security.static_api_keys = overrides.get("static_api_keys", [])
    return s


# =============================================================================
# get_settings
# =============================================================================

class TestGetSettings:
    """get_settings() — thin wrapper delegating to config.settings.get_settings."""

    def test_returns_settings_instance(self):
        """Returns a real Settings object from config."""
        from config.settings import Settings
        result = deps.get_settings()
        assert isinstance(result, Settings)

    def test_returns_valid_on_each_call(self):
        """Each call returns a valid Settings object (no internal caching)."""
        from config.settings import Settings
        a = deps.get_settings()
        b = deps.get_settings()
        assert isinstance(a, Settings)
        assert isinstance(b, Settings)


# =============================================================================
# get_runtime_settings
# =============================================================================

class TestGetRuntimeSettings:
    """get_runtime_settings() — resolves user settings with DB overrides."""

    @pytest.mark.asyncio
    async def test_gateway_none_returns_default_settings(self):
        """database_gateway is None → returns default settings."""
        from core.system.connection_manager import ConnectionManager
        original = ConnectionManager.get_instance().get_database_gateway()
        try:
            ConnectionManager.get_instance().set_database_gateway(None)
            req = _make_request()
            with patch("api.di.core.load_settings") as mock_ls:
                mock_settings = _make_settings()
                mock_ls.return_value = mock_settings
                result = await deps.get_runtime_settings(request=req, x_user_id=None, cache_control=None)
            assert result is mock_settings
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)

    @pytest.mark.asyncio
    async def test_cache_control_no_cache_forces_refresh(self):
        """Cache-Control: no-cache → force_refresh=True forwarded to application layer."""
        from data.database.persistence_gateway import SupabasePersistenceGateway
        from core.system.connection_manager import ConnectionManager
        original = ConnectionManager.get_instance().get_database_gateway()
        mock_gw = MagicMock(spec=SupabasePersistenceGateway)
        try:
            ConnectionManager.get_instance().set_database_gateway(mock_gw)
            req = _make_request()
            with patch("api.di.core.load_settings") as mock_ls:
                mock_ls.return_value = _make_settings()
                with patch(
                    "api.di.core.get_runtime_settings_service"
                ) as mock_get_rss:
                    mock_rss = AsyncMock()
                    mock_get_rss.return_value = mock_rss
                    await deps.get_runtime_settings(
                        request=req, x_user_id=None, cache_control="no-cache"
                    )
            mock_rss.get_runtime_settings.assert_called_once_with(
                mock_gw, "default_user", force_refresh=True
            )
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)

    @pytest.mark.asyncio
    async def test_cache_control_no_store_forces_refresh(self):
        """Cache-Control: No-Store → case-insensitive match → force_refresh=True."""
        from data.database.persistence_gateway import SupabasePersistenceGateway
        original = ConnectionManager.get_instance().get_database_gateway()
        mock_gw = MagicMock(spec=SupabasePersistenceGateway)
        try:
            ConnectionManager.get_instance().set_database_gateway(mock_gw)
            req = _make_request()
            with patch("api.di.core.load_settings") as mock_ls:
                mock_ls.return_value = _make_settings()
                with patch(
                    "api.di.core.get_runtime_settings_service"
                ) as mock_get_rss:
                    mock_rss = AsyncMock()
                    mock_get_rss.return_value = mock_rss
                    await deps.get_runtime_settings(
                        request=req, x_user_id=None, cache_control="No-Store"
                    )
            mock_rss.get_runtime_settings.assert_called_once_with(
                mock_gw, "default_user", force_refresh=True
            )
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)

    @pytest.mark.asyncio
    async def test_user_id_from_header_forwarded(self):
        """x_user_id from header is passed to runtime settings resolution."""
        from data.database.persistence_gateway import SupabasePersistenceGateway
        original = ConnectionManager.get_instance().get_database_gateway()
        mock_gw = MagicMock(spec=SupabasePersistenceGateway)
        try:
            ConnectionManager.get_instance().set_database_gateway(mock_gw)
            req = _make_request()
            with patch("api.di.core.load_settings") as mock_ls:
                mock_ls.return_value = _make_settings()
                with patch(
                    "api.di.core.get_runtime_settings_service"
                ) as mock_get_rss:
                    mock_rss = AsyncMock()
                    mock_get_rss.return_value = mock_rss
                    await deps.get_runtime_settings(
                        request=req, x_user_id="custom-user-123", cache_control=None
                    )
            mock_rss.get_runtime_settings.assert_called_once_with(
                mock_gw, "custom-user-123", force_refresh=False
            )
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)

    @pytest.mark.asyncio
    async def test_empty_user_id_falls_back_to_default(self):
        """Whitespace-only x_user_id → settings.security.default_user_id."""
        from data.database.persistence_gateway import SupabasePersistenceGateway
        original = ConnectionManager.get_instance().get_database_gateway()
        mock_gw = MagicMock(spec=SupabasePersistenceGateway)
        try:
            ConnectionManager.get_instance().set_database_gateway(mock_gw)
            req = _make_request()
            with patch("api.di.core.load_settings") as mock_ls:
                mock_ls.return_value = _make_settings(default_user_id="fallback-user")
                with patch(
                    "api.di.core.get_runtime_settings_service"
                ) as mock_get_rss:
                    mock_rss = AsyncMock()
                    mock_get_rss.return_value = mock_rss
                    await deps.get_runtime_settings(
                        request=req, x_user_id="   ", cache_control=None
                    )
            mock_rss.get_runtime_settings.assert_called_once_with(
                mock_gw, "fallback-user", force_refresh=False
            )
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)

    @pytest.mark.asyncio
    async def test_none_cache_control_no_forced_refresh(self):
        """cache_control=None → force_refresh=False."""
        from data.database.persistence_gateway import SupabasePersistenceGateway
        original = ConnectionManager.get_instance().get_database_gateway()
        mock_gw = MagicMock(spec=SupabasePersistenceGateway)
        try:
            ConnectionManager.get_instance().set_database_gateway(mock_gw)
            req = _make_request()
            with patch("api.di.core.load_settings") as mock_ls:
                mock_ls.return_value = _make_settings()
                with patch(
                    "api.di.core.get_runtime_settings_service"
                ) as mock_get_rss:
                    mock_rss = AsyncMock()
                    mock_get_rss.return_value = mock_rss
                    await deps.get_runtime_settings(
                        request=req, x_user_id=None, cache_control=None
                    )
            mock_rss.get_runtime_settings.assert_called_once_with(
                mock_gw, "default_user", force_refresh=False
            )
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)


# =============================================================================
# require_local_request — IP validation
# =============================================================================

class TestRequireLocalRequestIP:
    """require_local_request() — client IP validation layer."""

    def test_localhost_ipv4_allowed(self):
        """127.0.0.1 passes IP check."""
        req = _make_request(client_host="127.0.0.1", host_header="localhost")
        deps.require_local_request(req, _make_settings())

    def test_localhost_ipv6_allowed(self):
        """::1 passes IP check."""
        req = _make_request(client_host="::1", host_header="[::1]")
        deps.require_local_request(req, _make_settings())

    def test_docker_172_network_allowed(self):
        """172.x.x.x Docker internal IPs are allowed for internal mesh services."""
        req = _make_request(client_host="172.17.0.2", host_header="localhost")
        settings = _make_settings(environment="production")
        with patch.dict("os.environ", {"TESTING": "0", "AETHER_ALLOW_EXTERNAL_BIND": "false"}):
            # Should NOT raise HTTPException
            deps.require_local_request(req, settings)

    def test_docker_192_168_network_allowed(self):
        """192.168.x.x private IPs are allowed for internal mesh services."""
        req = _make_request(client_host="192.168.1.100", host_header="localhost")
        settings = _make_settings(environment="production")
        with patch.dict("os.environ", {"TESTING": "0", "AETHER_ALLOW_EXTERNAL_BIND": "false"}):
            # Should NOT raise HTTPException
            deps.require_local_request(req, settings)

    def test_docker_10_network_allowed(self):
        """10.x.x.x private IPs are allowed for internal mesh services."""
        req = _make_request(client_host="10.0.0.5", host_header="localhost")
        settings = _make_settings(environment="production")
        with patch.dict("os.environ", {"TESTING": "0", "AETHER_ALLOW_EXTERNAL_BIND": "false"}):
            # Should NOT raise HTTPException
            deps.require_local_request(req, settings)

    def test_lan_subnets_allowed_when_external_bind_enabled(self):
        """LAN subnets allowed when AETHER_ALLOW_EXTERNAL_BIND=true."""
        req = _make_request(client_host="192.168.1.100", host_header="localhost")
        settings = _make_settings()
        with patch.dict("os.environ", {"AETHER_ALLOW_EXTERNAL_BIND": "true"}):
            deps.require_local_request(req, settings)

    def test_external_ip_blocked_403(self):
        """Non-local IP (8.8.8.8) → 403."""
        req = _make_request(client_host="8.8.8.8", host_header="localhost")
        settings = _make_settings(environment="production")
        with patch.dict("os.environ", {"TESTING": "0"}):
            with pytest.raises(HTTPException) as exc_info:
                deps.require_local_request(req, settings)
            assert exc_info.value.status_code == 403
            assert "access denied" in exc_info.value.detail.lower()

    def test_testclient_allowed_in_test_env(self):
        """'testclient' host allowed when settings.environment=test."""
        req = _make_request(client_host="testclient", host_header="testclient")
        deps.require_local_request(req, _make_settings(environment="test"))

    def test_testserver_allowed_in_test_env(self):
        """'testserver' host allowed when settings.environment=test."""
        req = _make_request(client_host="testserver", host_header="testserver")
        deps.require_local_request(req, _make_settings(environment="test"))

    def test_test_client_blocked_without_testing_flag(self):
        """'testclient' blocked in production when TESTING != 1."""
        req = _make_request(client_host="testclient", host_header="localhost")
        settings = _make_settings(environment="production")
        with patch.dict("os.environ", {"TESTING": "0"}):
            with pytest.raises(HTTPException) as exc_info:
                deps.require_local_request(req, settings)
            assert exc_info.value.status_code == 403

    def test_testing_env_var_enables_test_clients(self):
        """TESTING=1 env var enables test client hosts in any environment."""
        req = _make_request(client_host="testclient", host_header="testclient")
        settings = _make_settings(environment="staging")
        with patch.dict("os.environ", {"TESTING": "1"}):
            deps.require_local_request(req, settings)

    def test_null_client_blocked(self):
        """request.client is None → client_host is None → 403."""
        req = _make_request(client_host="127.0.0.1", host_header="localhost")
        req.client = None
        settings = _make_settings(environment="production")
        with patch.dict("os.environ", {"TESTING": "0"}):
            with pytest.raises(HTTPException) as exc_info:
                deps.require_local_request(req, settings)
            assert exc_info.value.status_code == 403


# =============================================================================
# require_local_request — Host header validation
# =============================================================================

class TestRequireLocalRequestHost:
    """require_local_request() — Host header validation (DNS rebinding protection)."""

    def test_host_header_ipv4_with_port_stripped(self):
        """127.0.0.1:8765 → port stripped → 127.0.0.1 → allowed."""
        req = _make_request(client_host="127.0.0.1", host_header="127.0.0.1:8765")
        deps.require_local_request(req, _make_settings())

    def test_host_header_ipv6_with_port_stripped(self):
        """[::1]:8765 → parsed as [::1] → allowed."""
        req = _make_request(client_host="::1", host_header="[::1]:8765")
        deps.require_local_request(req, _make_settings())

    def test_empty_host_header_non_production_allowed(self):
        """Empty host header in non-production → early return."""
        req = _make_request(client_host="127.0.0.1", host_header="")
        deps.require_local_request(req, _make_settings(environment="development"))

    def test_empty_host_header_production_blocked_400(self):
        """Empty host header in production → 400."""
        req = _make_request(client_host="127.0.0.1", host_header="")
        settings = _make_settings(environment="production")
        with pytest.raises(HTTPException) as exc_info:
            deps.require_local_request(req, settings)
        assert exc_info.value.status_code == 400
        assert "Host header required" in exc_info.value.detail

    def test_dns_rebinding_external_host_blocked_403(self):
        """External host (evil.com) → 403 DNS rebinding protection."""
        req = _make_request(client_host="127.0.0.1", host_header="evil.com")
        settings = _make_settings(environment="production")
        with pytest.raises(HTTPException) as exc_info:
            deps.require_local_request(req, settings)
        assert exc_info.value.status_code == 403
        assert "Security violation" in exc_info.value.detail

    def test_host_docker_internal_allowed(self):
        """host.docker.internal is in the allowed host set."""
        req = _make_request(
            client_host="127.0.0.1", host_header="host.docker.internal"
        )
        deps.require_local_request(req, _make_settings())

    def test_host_0000_allowed(self):
        """0.0.0.0 host header is in the allowed set."""
        req = _make_request(client_host="127.0.0.1", host_header="0.0.0.0")
        deps.require_local_request(req, _make_settings())

    def test_localhost_with_custom_port_stripped(self):
        """localhost:9999 → port stripped → localhost → allowed."""
        req = _make_request(client_host="127.0.0.1", host_header="localhost:9999")
        deps.require_local_request(req, _make_settings())

    def test_test_host_header_allowed_in_test_env(self):
        """Host header 'testclient' allowed in test env (lines 148-149)."""
        req = _make_request(client_host="127.0.0.1", host_header="testclient")
        deps.require_local_request(req, _make_settings(environment="test"))

    def test_test_host_header_blocked_in_production(self):
        """Host header 'testclient' blocked in production without TESTING flag."""
        req = _make_request(client_host="127.0.0.1", host_header="testclient")
        settings = _make_settings(environment="production")
        with patch.dict("os.environ", {"TESTING": "0"}):
            with pytest.raises(HTTPException) as exc_info:
                deps.require_local_request(req, settings)
            assert exc_info.value.status_code == 403


# =============================================================================
# Runtime Engine singleton
# =============================================================================

class TestRuntimeEngine:
    """set_runtime_engine / get_runtime_engine."""

    def test_not_initialized_raises_503(self):
        """_runtime_engine is None → HTTPException 503."""
        import api.di.system as system_di
        original = system_di._runtime_engine
        try:
            system_di._runtime_engine = None
            with pytest.raises(HTTPException) as exc_info:
                deps.get_runtime_engine()
            assert exc_info.value.status_code == 503
            assert "Runtime engine not initialized" in exc_info.value.detail
        finally:
            system_di._runtime_engine = original

    def test_set_and_get_round_trip(self):
        """set_runtime_engine stores, get_runtime_engine retrieves."""
        import api.di.system as system_di
        original = system_di._runtime_engine
        mock_engine = MagicMock()
        try:
            deps.set_runtime_engine(mock_engine)
            assert deps.get_runtime_engine() is mock_engine
        finally:
            system_di._runtime_engine = original


# =============================================================================
# MCP Manager
# =============================================================================

class TestMCPManager:
    """get_mcp_manager / require_mcp_manager."""

    def test_get_mcp_manager_proxies_to_context(self):
        """Delegates to core.mcp.context._get_mcp_manager."""
        mock_mgr = MagicMock()
        with patch("api.di.agents._get_mcp_manager", return_value=mock_mgr):
            assert deps.get_mcp_manager() is mock_mgr

    def test_get_mcp_manager_returns_none(self):
        """Returns None when context manager is not initialized."""
        with patch("api.di.agents._get_mcp_manager", return_value=None):
            assert deps.get_mcp_manager() is None

    def test_require_mcp_manager_none_raises_503(self):
        """Manager is None → 503."""
        with patch("api.di.agents._get_mcp_manager", return_value=None):
            with pytest.raises(HTTPException) as exc_info:
                deps.require_mcp_manager()
            assert exc_info.value.status_code == 503
            assert "MCP" in exc_info.value.detail

    def test_require_mcp_manager_returns_manager(self):
        """Manager available → returned."""
        mock_mgr = MagicMock()
        with patch("api.di.agents._get_mcp_manager", return_value=mock_mgr):
            assert deps.require_mcp_manager() is mock_mgr


# =============================================================================
# File Indexing Repository
# =============================================================================

class TestFileIndexingRepository:
    """set/get/require_file_indexing_repository."""

    def test_get_returns_none_when_unset(self):
        """Default state is None."""
        original = ConnectionManager.get_instance().get_file_indexing_repository()
        try:
            ConnectionManager.get_instance().set_file_indexing_repository(None)
            assert deps.get_file_indexing_repository() is None
        finally:
            ConnectionManager.get_instance().set_file_indexing_repository(original)

    def test_set_and_get_round_trip(self):
        """Setter stores, getter retrieves."""
        original = ConnectionManager.get_instance().get_file_indexing_repository()
        mock_repo = MagicMock()
        try:
            deps.set_file_indexing_repository(mock_repo)
            assert deps.get_file_indexing_repository() is mock_repo
        finally:
            ConnectionManager.get_instance().set_file_indexing_repository(original)

    def test_require_raises_503_when_none(self):
        """Not initialized → 503."""
        original = ConnectionManager.get_instance().get_file_indexing_repository()
        original_db = ConnectionManager.get_instance().get_database_gateway()
        try:
            ConnectionManager.get_instance().set_file_indexing_repository(None)
            ConnectionManager.get_instance().set_database_gateway(None)
            with pytest.raises(HTTPException) as exc_info:
                deps.require_file_indexing_repository()
            assert exc_info.value.status_code == 503
            assert "File indexing" in exc_info.value.detail
        finally:
            ConnectionManager.get_instance().set_file_indexing_repository(original)
            ConnectionManager.get_instance().set_database_gateway(original_db)

    def test_require_returns_repo(self):
        """Initialized → returned."""
        original = ConnectionManager.get_instance().get_file_indexing_repository()
        mock_repo = MagicMock()
        try:
            deps.set_file_indexing_repository(mock_repo)
            assert deps.require_file_indexing_repository() is mock_repo
        finally:
            ConnectionManager.get_instance().set_file_indexing_repository(original)

    def test_require_lazy_initializes_from_database_connection(self):
        """Unset repository + available DB gateway → repository is lazily initialized."""
        original_repo = ConnectionManager.get_instance().get_file_indexing_repository()
        original_db = ConnectionManager.get_instance().get_database_gateway()
        mock_gateway = MagicMock()
        mock_repo = MagicMock()
        try:
            ConnectionManager.get_instance().set_file_indexing_repository(None)
            ConnectionManager.get_instance().set_database_gateway(mock_gateway)
            with patch(
                "data.database.repositories.files.FileIndexingRepository",
                return_value=mock_repo,
            ) as mock_repo_ctor:
                result = deps.require_file_indexing_repository()

            assert result is mock_repo
            assert ConnectionManager.get_instance().get_file_indexing_repository() is mock_repo
            mock_repo_ctor.assert_called_once_with(mock_gateway)
        finally:
            ConnectionManager.get_instance().set_file_indexing_repository(original_repo)
            ConnectionManager.get_instance().set_database_gateway(original_db)

    def test_require_lazy_init_failure_still_raises_503(self):
        """Lazy repository init failure does not mask unavailable service semantics."""
        original_repo = ConnectionManager.get_instance().get_file_indexing_repository()
        original_db = ConnectionManager.get_instance().get_database_gateway()
        mock_gateway = MagicMock()
        try:
            ConnectionManager.get_instance().set_file_indexing_repository(None)
            ConnectionManager.get_instance().set_database_gateway(mock_gateway)
            with patch(
                "data.database.repositories.files.FileIndexingRepository",
                side_effect=RuntimeError("init failed"),
            ):
                with pytest.raises(HTTPException) as exc_info:
                    deps.require_file_indexing_repository()

            assert exc_info.value.status_code == 503
            assert "File indexing service not initialized" in exc_info.value.detail
        finally:
            ConnectionManager.get_instance().set_file_indexing_repository(original_repo)
            ConnectionManager.get_instance().set_database_gateway(original_db)


# =============================================================================
# Database Connection & get_database async generator
# =============================================================================

class TestDatabaseConnection:
    """set/get_database_connection and get_database async generator."""

    def test_set_and_get_round_trip(self):
        """Setter/getter round-trip."""
        original = ConnectionManager.get_instance().get_database_gateway()
        mock_gw = MagicMock()
        try:
            deps.set_database_connection(mock_gw)
            assert deps.get_database_connection() is mock_gw
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)

    async def test_get_database_yields_connection(self):
        """Async generator yields the gateway."""
        original = ConnectionManager.get_instance().get_database_gateway()
        mock_gw = MagicMock()
        try:
            ConnectionManager.get_instance().set_database_gateway(mock_gw)
            gen = deps.get_database()
            result = await gen.__anext__()
            assert result is mock_gw
            await gen.aclose()
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)

    @pytest.mark.asyncio
    async def test_get_database_none_raises_503(self):
        """_database_connection is None → 503."""
        original = ConnectionManager.get_instance().get_database_gateway()
        try:
            ConnectionManager.get_instance().set_database_gateway(None)
            gen = deps.get_database()
            with pytest.raises(HTTPException) as exc_info:
                await gen.__anext__()
            assert exc_info.value.status_code == 503
            assert "Database not available" in exc_info.value.detail
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)


# =============================================================================
# Supabase Unit of Work
# =============================================================================

class TestSupabaseUoW:
    """get_supabase_uow async generator."""

    @pytest.mark.asyncio
    async def test_none_database_raises_503(self):
        """_database_connection is None → 503."""
        original = ConnectionManager.get_instance().get_database_gateway()
        try:
            ConnectionManager.get_instance().set_database_gateway(None)
            req = _make_request()
            gen = deps.get_supabase_uow(request=req)
            with pytest.raises(HTTPException) as exc_info:
                await gen.__anext__()
            assert exc_info.value.status_code == 503
            assert "Database not available" in exc_info.value.detail
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)

    @pytest.mark.asyncio
    async def test_yields_uow_and_calls_close(self):
        """Yields SupabaseUnitOfWork, calls close() in finally."""
        original = ConnectionManager.get_instance().get_database_gateway()
        mock_gw = MagicMock()
        try:
            ConnectionManager.get_instance().set_database_gateway(mock_gw)
            req = _make_request()
            req.state.request_id = "req-123"
            req.state.correlation_id = "corr-456"
            req.state.session_id = "sess-789"
            req.state.user_id = "user-abc"
            req.state.operator_id = "op-def"
            req.state.frontend_id = "fe-ghi"

            mock_uow = AsyncMock()
            mock_uow.close = AsyncMock()

            with patch("api.di.database.SupabaseUnitOfWork", return_value=mock_uow):
                with patch("api.di.database.SupabaseRequestContext") as mock_ctx_cls:
                    gen = deps.get_supabase_uow(request=req)
                    result = await gen.__anext__()

            assert result is mock_uow
            mock_uow.__aenter__.assert_called_once()

            # Verify context was built correctly
            ctx_call = mock_ctx_cls.call_args
            assert ctx_call.kwargs["request_id"] == "req-123"
            assert ctx_call.kwargs["correlation_id"] == "corr-456"
            assert ctx_call.kwargs["session_id"] == "sess-789"
            assert ctx_call.kwargs["user_id"] == "user-abc"
            assert ctx_call.kwargs["actor_id"] == "op-def"

            # Trigger finally block
            await gen.aclose()
            mock_uow.close.assert_called_once()
        finally:
            ConnectionManager.get_instance().set_database_gateway(original)


# =============================================================================
# Redis Session
# =============================================================================

class TestRedisSession:
    """get_redis_session — Redis session context construction."""

    def _setup_request_state(self, req):
        """Set default state attributes for Redis tests."""
        req.state.request_id = "r-1"
        req.state.correlation_id = "c-1"
        req.state.session_id = "s-1"
        req.state.user_id = "u-1"
        req.state.operator_id = None
        req.state.frontend_id = "f-1"

    def test_default_namespace_is_runtime(self):
        """No redis config → namespace='runtime'."""
        import api.di.database as database_di
        original = database_di._cache_client
        mock_cache = MagicMock()
        try:
            database_di._cache_client = mock_cache
            req = _make_request()
            self._setup_request_state(req)
            settings = _make_settings()
            settings.redis = None

            with patch("api.di.database.RedisSessionContext") as mock_cls:
                mock_cls.return_value = MagicMock()
                result = deps.get_redis_session(request=req, settings=settings)

            assert mock_cls.call_count == 1
            call_kw = mock_cls.call_args.kwargs
            assert call_kw["namespace"] == "runtime"
            assert call_kw["cache"] is mock_cache
        finally:
            database_di._cache_client = original

    def test_custom_namespace_prepended(self):
        """Redis namespace from settings is prepended as 'ns:runtime'."""
        import api.di.database as database_di
        original = database_di._cache_client
        mock_cache = MagicMock()
        try:
            database_di._cache_client = mock_cache
            req = _make_request()
            self._setup_request_state(req)
            settings = _make_settings()
            redis_ns = MagicMock()
            redis_ns.namespace = "aether-prod"
            settings.redis = redis_ns

            with patch("api.di.database.RedisSessionContext") as mock_cls:
                mock_cls.return_value = MagicMock()
                deps.get_redis_session(request=req, settings=settings)

            call_kw = mock_cls.call_args.kwargs
            assert call_kw["namespace"] == "aether-prod:runtime"
        finally:
            database_di._cache_client = original

    def test_namespace_exception_falls_back_to_runtime(self):
        """Exception accessing redis config → namespace falls back to 'runtime'."""
        import api.di.database as database_di
        original = database_di._cache_client
        mock_cache = MagicMock()
        try:
            database_di._cache_client = mock_cache
            req = _make_request()
            self._setup_request_state(req)
            settings = _make_settings()
            # Make getattr(settings, "redis") raise RuntimeError (not AttributeError)
            # getattr only catches AttributeError for default; RuntimeError propagates
            type(settings).redis = PropertyMock(
                side_effect=RuntimeError("redis config broken")
            )

            with patch("api.di.database.RedisSessionContext") as mock_cls:
                mock_cls.return_value = MagicMock()
                deps.get_redis_session(request=req, settings=settings)

            call_kw = mock_cls.call_args.kwargs
            assert call_kw["namespace"] == "runtime"
        finally:
            database_di._cache_client = original

    def test_redis_context_receives_request_metadata(self):
        """RedisRequestContext is built from _build_request_context_payload."""
        import api.di.database as database_di
        original = database_di._cache_client
        mock_cache = MagicMock()
        try:
            database_di._cache_client = mock_cache
            req = _make_request()
            self._setup_request_state(req)
            settings = _make_settings()
            settings.redis = None

            with patch("api.di.database.RedisSessionContext") as mock_cls:
                with patch("api.di.database.RedisRequestContext") as mock_rrc:
                    mock_rrc.return_value = MagicMock()
                    mock_cls.return_value = MagicMock()
                    deps.get_redis_session(request=req, settings=settings)

            rrc_call = mock_rrc.call_args
            assert rrc_call.kwargs["request_id"] == "r-1"
            assert rrc_call.kwargs["correlation_id"] == "c-1"
            assert rrc_call.kwargs["session_id"] == "s-1"
            assert rrc_call.kwargs["user_id"] == "u-1"
        finally:
            database_di._cache_client = original


# =============================================================================
# Cache Client
# =============================================================================

class TestCacheClient:
    """set_cache_client / get_cache_client."""

    def test_set_and_get_round_trip(self):
        import api.di.database as database_di
        original = database_di._cache_client
        mock_cache = MagicMock()
        try:
            deps.set_cache_client(mock_cache)
            assert deps.get_cache_client() is mock_cache
        finally:
            database_di._cache_client = original

    def test_set_none_clears(self):
        import api.di.database as database_di
        original = database_di._cache_client
        try:
            deps.set_cache_client(MagicMock())
            deps.set_cache_client(None)
            assert deps.get_cache_client() is None
        finally:
            database_di._cache_client = original


# =============================================================================
# Service Factories (ChatService, ChatSummaryService)
# =============================================================================

class TestServiceFactories:
    """get_chat_service / get_summary_service."""

    @pytest.mark.asyncio
    async def test_get_chat_service_creates_with_uow_and_settings(self):
        """ChatService is constructed with the provided UoW and Settings."""
        mock_uow = MagicMock()
        mock_settings = MagicMock()
        with patch("application.chat.ChatService") as mock_cls:
            mock_cls.return_value = MagicMock()
            result = await deps.get_chat_service(uow=mock_uow, settings=mock_settings)
        mock_cls.assert_called_once_with(mock_uow, mock_settings)
        assert result is mock_cls.return_value

    @pytest.mark.asyncio
    async def test_get_summary_service_creates_with_uow_and_settings(self):
        """ChatSummaryService is constructed with UoW and Settings."""
        mock_uow = MagicMock()
        mock_settings = MagicMock()
        with patch("application.chat.summary_service.ChatSummaryService") as mock_cls:
            mock_cls.return_value = MagicMock()
            result = await deps.get_summary_service(
                uow=mock_uow, settings=mock_settings
            )
        mock_cls.assert_called_once_with(mock_uow, mock_settings)
        assert result is mock_cls.return_value


# =============================================================================
# Authentication (_get_authentication_manager, require_auth_context)
# =============================================================================

class TestAuthentication:
    """_get_authentication_manager and require_auth_context."""

    def test_auth_config_built_from_settings(self):
        """AuthConfig is constructed with correct values from settings."""
        settings = _make_settings(
            auth_enabled=True,
            api_key_required=True,
            api_key_header="X-Custom-Key",
            allow_bearer_tokens=False,
            allow_anonymous=False,
            default_role="admin",
            static_api_keys=[],
        )
        import api.di.security as security_di
        original = security_di._auth_seeded
        try:
            security_di._auth_seeded = True  # Skip seeding path for this test
            with patch("api.di.security.get_auth_manager") as mock_gam:
                mock_manager = MagicMock()
                mock_gam.return_value = mock_manager
                result = security_di._get_authentication_manager(settings)

            config = mock_gam.call_args[0][0]
            assert config.require_api_key is True
            assert config.api_key_header == "X-Custom-Key"
            assert config.allow_bearer_tokens is False
            assert config.allow_anonymous is False
            assert result is mock_manager
            assert mock_manager.config is config
        finally:
            security_di._auth_seeded = original

    def test_anonymous_allowed_when_no_api_key_required(self):
        """auth_enabled=False, api_key_required=False → allow_anonymous=True."""
        settings = _make_settings(
            auth_enabled=False,
            api_key_required=False,
            allow_anonymous=True,
        )
        import api.di.security as security_di
        original = security_di._auth_seeded
        try:
            security_di._auth_seeded = True
            with patch("api.di.security.get_auth_manager") as mock_gam:
                mock_gam.return_value = MagicMock()
                security_di._get_authentication_manager(settings)

            config = mock_gam.call_args[0][0]
            assert config.require_api_key is False
            assert config.allow_anonymous is True
        finally:
            security_di._auth_seeded = original

    def test_static_api_keys_seeded_once(self):
        """API keys from settings.security.static_api_keys are registered exactly once."""
        key_def = MagicMock()
        key_def.user_id = "svc-user"
        key_def.role = "service"
        key_def.description = "Test service key"
        key_def.key = "ak-secret-12345"

        settings = _make_settings(static_api_keys=[key_def])
        import api.di.security as security_di
        original = security_di._auth_seeded
        try:
            security_di._auth_seeded = False
            with patch("api.di.security.get_auth_manager") as mock_gam:
                mock_manager = MagicMock()
                mock_gam.return_value = mock_manager

                # First call seeds keys
                security_di._get_authentication_manager(settings)
                assert mock_manager.register_api_key.call_count == 1
                call_kw = mock_manager.register_api_key.call_args.kwargs
                assert call_kw["user_id"] == "svc-user"
                assert call_kw["api_key"] == "ak-secret-12345"
                assert call_kw["role"] == "service"
                assert call_kw["description"] == "Test service key"
                assert call_kw["metadata"] == {"source": "settings.api_keys"}

                # Second call does NOT seed again
                security_di._get_authentication_manager(settings)
                assert mock_manager.register_api_key.call_count == 1
        finally:
            security_di._auth_seeded = original

    def test_key_role_falls_back_to_default(self):
        """API key with role=None → default_role used."""
        key_def = MagicMock()
        key_def.user_id = "user-1"
        key_def.role = None
        key_def.description = None
        key_def.key = "ak-fallback"

        settings = _make_settings(static_api_keys=[key_def], default_role="user")
        import api.di.security as security_di
        original = security_di._auth_seeded
        try:
            security_di._auth_seeded = False
            with patch("api.di.security.get_auth_manager") as mock_gam:
                mock_manager = MagicMock()
                mock_gam.return_value = mock_manager
                security_di._get_authentication_manager(settings)

            call_kw = mock_manager.register_api_key.call_args.kwargs
            # When key_def.role is None, code uses config.default_role
            assert call_kw["role"] is not None  # Should be the config default
        finally:
            security_di._auth_seeded = original

    @pytest.mark.asyncio
    async def test_require_auth_context_success_with_api_key(self):
        """Valid API key → AuthorizationContext returned and stored in state."""
        settings = _make_settings()
        mock_context = MagicMock()
        mock_manager = MagicMock()
        mock_manager.authenticate_request.return_value = mock_context

        req = _make_request(headers={"X-API-Key": "valid-key-123"})

        with patch(
            "api.di.security._get_authentication_manager",
            return_value=mock_manager,
        ):
            result = await deps.require_auth_context(request=req, settings=settings)

        assert result is mock_context
        mock_manager.authenticate_request.assert_called_once_with(
            api_key="valid-key-123",
            bearer_token=None,
        )
        assert req.state.auth_context is mock_context

    @pytest.mark.asyncio
    async def test_require_auth_context_extracts_bearer_token(self):
        """Bearer token extracted from Authorization header."""
        settings = _make_settings()
        mock_context = MagicMock()
        mock_manager = MagicMock()
        mock_manager.authenticate_request.return_value = mock_context

        req = _make_request(headers={"Authorization": "Bearer jwt-token-xyz"})

        with patch(
            "api.di.security._get_authentication_manager",
            return_value=mock_manager,
        ):
            await deps.require_auth_context(request=req, settings=settings)

        mock_manager.authenticate_request.assert_called_once_with(
            api_key=None,
            bearer_token="jwt-token-xyz",
        )

    @pytest.mark.asyncio
    async def test_require_auth_context_empty_bearer_is_none(self):
        """'Bearer   ' (whitespace only) → bearer_token=None."""
        settings = _make_settings()
        mock_context = MagicMock()
        mock_manager = MagicMock()
        mock_manager.authenticate_request.return_value = mock_context

        req = _make_request(headers={"Authorization": "Bearer   "})

        with patch(
            "api.di.security._get_authentication_manager",
            return_value=mock_manager,
        ):
            await deps.require_auth_context(request=req, settings=settings)

        mock_manager.authenticate_request.assert_called_once_with(
            api_key=None,
            bearer_token=None,
        )

    @pytest.mark.asyncio
    async def test_require_auth_context_auth_error_raises_401(self):
        """AuthenticationError from manager → HTTPException 401."""
        from security.auth import AuthenticationError

        settings = _make_settings()
        mock_manager = MagicMock()
        mock_manager.authenticate_request.side_effect = AuthenticationError(
            "Invalid API key"
        )

        req = _make_request(headers={"X-API-Key": "bad-key"})

        with patch(
            "api.di.security._get_authentication_manager",
            return_value=mock_manager,
        ):
            with pytest.raises(HTTPException) as exc_info:
                await deps.require_auth_context(request=req, settings=settings)
            assert exc_info.value.status_code == 401
            assert "Invalid API key" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_require_auth_context_non_bearer_auth_header_ignored(self):
        """'Basic xxx' Authorization header → bearer_token stays None."""
        settings = _make_settings()
        mock_context = MagicMock()
        mock_manager = MagicMock()
        mock_manager.authenticate_request.return_value = mock_context

        req = _make_request(headers={"Authorization": "Basic dXNlcjpwYXNz"})

        with patch(
            "api.di.security._get_authentication_manager",
            return_value=mock_manager,
        ):
            await deps.require_auth_context(request=req, settings=settings)

        mock_manager.authenticate_request.assert_called_once_with(
            api_key=None,
            bearer_token=None,
        )


# =============================================================================
# Anonymous Context
# =============================================================================

class TestAnonymousContext:
    """get_anonymous_context."""

    def test_returns_anonymous_authorization_context(self):
        """Returns AuthorizationContext with anonymous user and role."""
        from security.permissions import AuthorizationContext

        with patch("api.dependencies.get_permission_manager") as mock_pm:
            mock_pm.return_value = MagicMock()
            result = deps.get_anonymous_context()

        assert isinstance(result, AuthorizationContext)
        assert result.user.user_id == "anonymous"
        assert result.user.role == "anonymous"
        assert result.user.metadata == {"authenticated": False}


# =============================================================================
# _build_request_context_payload
# =============================================================================

class TestBuildRequestContextPayload:
    """_build_request_context_payload — normalize request metadata."""

    def test_full_request_state_populates_all_fields(self):
        """All state attributes → fully populated payload."""
        req = _make_request(method="POST", path="/v1/chat")
        req.state.request_id = "req-abc"
        req.state.correlation_id = "corr-def"
        req.state.session_id = "sess-ghi"
        req.state.user_id = "user-jkl"
        req.state.operator_id = "op-mno"
        req.state.frontend_id = "fe-pqr"
        req.client.host = "127.0.0.1"

        result = deps._build_request_context_payload(req)

        assert result["request_id"] == "req-abc"
        assert result["correlation_id"] == "corr-def"
        assert result["session_id"] == "sess-ghi"
        assert result["user_id"] == "user-jkl"
        assert result["actor_id"] == "op-mno"
        assert result["extras"]["http.method"] == "POST"
        assert result["extras"]["http.path"] == "/v1/chat"
        assert result["extras"]["client.ip"] == "127.0.0.1"
        assert result["extras"]["frontend.id"] == "fe-pqr"

    def test_none_request_returns_generated_ids(self):
        """None request → generated UUID for request_id, empty extras."""
        result = deps._build_request_context_payload(None)
        assert result["request_id"]  # Non-empty UUID string
        assert result["correlation_id"] == result["request_id"]
        assert result["session_id"] is None
        assert result["user_id"] is None
        assert result["actor_id"] is None
        assert result["extras"] == {}

    def test_url_path_exception_yields_none_http_path(self):
        """request.url.path raises → http.path omitted from extras."""
        req = _make_request()
        req.state.request_id = "req-1"
        req.state.correlation_id = None
        req.state.session_id = None
        req.state.user_id = None
        req.state.operator_id = None
        req.state.frontend_id = None
        req.client = None
        req.method = "GET"

        url_mock = MagicMock()
        type(url_mock).path = PropertyMock(side_effect=RuntimeError("url broken"))
        req.url = url_mock

        result = deps._build_request_context_payload(req)
        assert "http.path" not in result["extras"]

    def test_actor_id_falls_back_to_user_id(self):
        """operator_id is None → actor_id == user_id."""
        req = _make_request()
        req.state.request_id = "r"
        req.state.correlation_id = "c"
        req.state.session_id = None
        req.state.user_id = "the-user"
        req.state.operator_id = None
        req.state.frontend_id = None
        req.client = None

        result = deps._build_request_context_payload(req)
        assert result["actor_id"] == "the-user"

    def test_none_extras_filtered_out(self):
        """None-valued extras are excluded from the dict."""
        req = _make_request()
        req.state.request_id = "r"
        req.state.correlation_id = "c"
        req.state.session_id = None
        req.state.user_id = None
        req.state.operator_id = None
        req.state.frontend_id = None
        req.client = None
        req.method = None

        result = deps._build_request_context_payload(req)
        # All extras are None → filtered out
        for key in ("http.method", "client.ip", "frontend.id"):
            assert key not in result["extras"]


# =============================================================================
# Pagination
# =============================================================================

class TestPaginationParams:
    """PaginationParams and get_pagination_params."""

    def test_default_values(self):
        p = deps.PaginationParams()
        assert p.skip == 0
        assert p.limit == 100
        assert p.max_limit == 1000

    def test_negative_skip_clamped_to_zero(self):
        p = deps.PaginationParams(skip=-5)
        assert p.skip == 0

    def test_limit_exceeding_max_clamped(self):
        p = deps.PaginationParams(limit=5000, max_limit=100)
        assert p.limit == 100

    def test_zero_limit_clamped_to_one(self):
        p = deps.PaginationParams(limit=0)
        assert p.limit == 1

    def test_negative_limit_clamped_to_one(self):
        p = deps.PaginationParams(limit=-10)
        assert p.limit == 1

    def test_custom_max_limit(self):
        p = deps.PaginationParams(skip=10, limit=50, max_limit=200)
        assert p.skip == 10
        assert p.limit == 50
        assert p.max_limit == 200

    def test_get_pagination_params_factory(self):
        result = deps.get_pagination_params(skip=5, limit=50)
        assert isinstance(result, deps.PaginationParams)
        assert result.skip == 5
        assert result.limit == 50

    def test_get_pagination_params_defaults(self):
        result = deps.get_pagination_params()
        assert result.skip == 0
        assert result.limit == 100


# =============================================================================
# Omni Service Lifecycle
# =============================================================================

class TestOmniServiceLifecycle:
    """get_omni_service / shutdown_omni_service."""

    @pytest.mark.asyncio
    async def test_shutdown_when_active_calls_shutdown_and_clears(self):
        """Active service → shutdown() called, global set to None."""
        import api.di.agents as agents_di
        mock_svc = AsyncMock()
        original = agents_di._omni_service
        try:
            agents_di._omni_service = mock_svc
            await deps.shutdown_omni_service()
            mock_svc.shutdown.assert_called_once()
            assert agents_di._omni_service is None
        finally:
            agents_di._omni_service = original

    @pytest.mark.asyncio
    async def test_shutdown_when_none_is_noop(self):
        """None service → no error, stays None."""
        import api.di.agents as agents_di
        original = agents_di._omni_service
        try:
            agents_di._omni_service = None
            await deps.shutdown_omni_service()
            assert agents_di._omni_service is None
        finally:
            agents_di._omni_service = original


# =============================================================================
# setup_request_context / cleanup_request_context / check_rate_limit
# =============================================================================

class TestRequestContext:
    """setup_request_context, cleanup_request_context, check_rate_limit."""

    @pytest.mark.asyncio
    async def test_setup_generates_ids_when_not_provided(self):
        """Missing headers → IDs auto-generated, defaults applied."""
        req = _make_request()
        with patch("api.di.core.set_request_context"):
            result = await deps.setup_request_context(
                request=req,
                x_request_id=None,
                x_user_id=None,
                x_session_id=None,
                x_chat_id=None,
                x_frontend_id=None,
                x_correlation_id=None,
                x_operator_id=None,
            )

        assert result["request_id"]  # Non-empty UUID
        assert result["correlation_id"] == result["request_id"]
        assert result["frontend_id"] == "local-single-user"
        assert result["user_id"] is None
        assert result["session_id"] is None
        assert result["chat_id"] is None
        assert result["operator_id"] is None
        assert result["method"] == "GET"
        assert result["path"] == "/v1/test"

    @pytest.mark.asyncio
    async def test_setup_uses_provided_values(self):
        """Provided header values are used directly."""
        req = _make_request()
        with patch("api.di.core.set_request_context"):
            result = await deps.setup_request_context(
                request=req,
                x_request_id="my-req",
                x_user_id="my-user",
                x_session_id="my-session",
                x_chat_id="my-chat",
                x_frontend_id="my-frontend",
                x_correlation_id="my-corr",
                x_operator_id="my-op",
            )

        assert result["request_id"] == "my-req"
        assert result["user_id"] == "my-user"
        assert result["session_id"] == "my-session"
        assert result["chat_id"] == "my-chat"
        assert result["frontend_id"] == "my-frontend"
        assert result["correlation_id"] == "my-corr"
        assert result["operator_id"] == "my-op"

    @pytest.mark.asyncio
    async def test_chat_id_becomes_session_id_when_session_absent(self):
        """x_session_id=None + x_chat_id=present → session_id=chat_id."""
        req = _make_request()
        with patch("api.di.core.set_request_context"):
            result = await deps.setup_request_context(
                request=req,
                x_request_id=None,
                x_user_id=None,
                x_session_id=None,
                x_chat_id="chat-xyz",
                x_frontend_id=None,
                x_correlation_id=None,
                x_operator_id=None,
            )

        assert result["session_id"] == "chat-xyz"
        assert result["chat_id"] == "chat-xyz"

    @pytest.mark.asyncio
    async def test_setup_stores_context_in_request_state(self):
        """Values are stored on request.state for downstream access."""
        req = _make_request()
        with patch("api.di.core.set_request_context"):
            await deps.setup_request_context(
                request=req,
                x_request_id="r-1",
                x_user_id="u-1",
                x_session_id="s-1",
                x_chat_id="c-1",
                x_frontend_id="f-1",
                x_correlation_id="cr-1",
                x_operator_id="op-1",
            )

        assert req.state.request_id == "r-1"
        assert req.state.user_id == "u-1"
        assert req.state.session_id == "s-1"
        assert req.state.chat_id == "c-1"
        assert req.state.frontend_id == "f-1"
        assert req.state.correlation_id == "cr-1"
        assert req.state.operator_id == "op-1"

    @pytest.mark.asyncio
    async def test_setup_calls_set_request_context_with_correct_args(self):
        """set_request_context is called with all resolved values."""
        req = _make_request()
        with patch("api.di.core.set_request_context") as mock_src:
            await deps.setup_request_context(
                request=req,
                x_request_id="r-1",
                x_user_id="u-1",
                x_session_id="s-1",
                x_chat_id="c-1",
                x_frontend_id="f-1",
                x_correlation_id="cr-1",
                x_operator_id="op-1",
            )

        mock_src.assert_called_once_with(
            request_id="r-1",
            user_id="u-1",
            session_id="s-1",
            chat_id="c-1",
            frontend_id="f-1",
            correlation_id="cr-1",
            operator_id="op-1",
        )

    @pytest.mark.asyncio
    async def test_cleanup_calls_clear_request_context(self):
        """cleanup_request_context delegates to clear_request_context."""
        with patch("api.di.core.clear_request_context") as mock_clear:
            await deps.cleanup_request_context()
        mock_clear.assert_called_once()

    @pytest.mark.asyncio
    async def test_check_rate_limit_is_noop_placeholder(self):
        """check_rate_limit does nothing (placeholder)."""
        req = _make_request()
        await deps.check_rate_limit(request=req)
        await deps.check_rate_limit(request=req, identifier="user-1")


# =============================================================================
# require_local_request_dependency wrapper
# =============================================================================

class TestRequireLocalRequestDependency:
    """require_local_request_dependency — thin wrapper."""

    def test_delegates_to_require_local_request(self):
        """Calls require_local_request with same args."""
        req = _make_request(client_host="127.0.0.1", host_header="localhost")
        settings = _make_settings()
        # Should not raise for local request
        deps.require_local_request_dependency(request=req, settings=settings)

    def test_propagates_403_from_inner(self):
        """Non-local request → 403 propagated."""
        req = _make_request(client_host="8.8.8.8", host_header="localhost")
        settings = _make_settings(environment="production")
        with patch.dict("os.environ", {"TESTING": "0"}):
            with pytest.raises(HTTPException) as exc_info:
                deps.require_local_request_dependency(request=req, settings=settings)
            assert exc_info.value.status_code == 403


# =============================================================================
# RequestContextLifecycleMiddleware — cleanup exception path
# =============================================================================

class TestRequestContextMiddlewareCleanupException:
    """Coverage gap: request_context.py lines 44-46."""

    async def test_cleanup_exception_does_not_break_request(self, client):
        """Lines 44-46: exception in cleanup_request_context is caught gracefully."""
        with patch(
            "api.dependencies.cleanup_request_context",
            new_callable=AsyncMock,
            side_effect=RuntimeError("cleanup exploded"),
        ):
            # Any request should still succeed — middleware catches cleanup errors
            resp = await client.get("/v1/health")
        assert resp.status_code == 200
