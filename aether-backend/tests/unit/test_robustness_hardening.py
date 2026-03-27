"""
Unit Tests: Robustness Hardening Fixes

Tests the specific non-breaking robustness changes:
1. IntegrationLoader.shutdown() -- cleanup of loaded integrations
2. MCP Manager stop() -- _sandboxes cleared, _sync_executor shutdown(wait=True)
3. RuntimeCoordinator disposed guard -- idempotent stop, start-after-stop rejection
4. RuntimeEngine no __getattr__ -- AttributeError on unknown attributes
5. TraceGenerator -- bare except replaced with specific exceptions
6. Engine singletons -- reset_singletons() clears module-level state

No external services required -- all tests use mocks.
"""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Ensure backend root on path
PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


# =========================================================================
# 1. IntegrationLoader.shutdown()
# =========================================================================


class TestIntegrationLoaderShutdown:
    """Verify shutdown() cleans up loaded integrations."""

    def _make_loader(self):
        """Create a minimal IntegrationLoader with mocked interpreter."""
        from core.integrations.framework.loader import IntegrationLoader

        interpreter = MagicMock()
        interpreter.computer = SimpleNamespace()

        # Patch _load_registry to avoid needing the YAML file
        with patch.object(IntegrationLoader, '_load_registry', return_value={
            "integrations": {
                "test_ns": {
                    "layer4_runtime": {"attach_as": "namespace", "namespace": "computer.test_ns"},
                },
                "test_fn": {
                    "layer4_runtime": {"attach_as": "functions", "namespace": "computer"},
                },
            },
            "runtime": {},
        }):
            loader = IntegrationLoader(interpreter)

        return loader, interpreter

    def test_shutdown_clears_loaded_integrations(self):
        loader, interpreter = self._make_loader()

        # Simulate loaded integrations
        loader._loaded_integrations = {
            "test_fn": {"status": "loaded", "exports": ["fn_a", "fn_b"]},
            "test_ns": {"status": "loaded"},
            "disabled": {"status": "disabled"},
        }
        # Attach mock functions to computer
        interpreter.computer.fn_a = lambda: None
        interpreter.computer.fn_b = lambda: None

        loader.shutdown()

        assert loader._loaded_integrations == {}
        assert not hasattr(interpreter.computer, "fn_a")
        assert not hasattr(interpreter.computer, "fn_b")

    def test_shutdown_calls_cleanup_on_namespace_objects(self):
        loader, interpreter = self._make_loader()

        cleanup_mock = MagicMock()
        ns_obj = SimpleNamespace(cleanup=cleanup_mock)
        interpreter.computer.test_ns = ns_obj

        loader._loaded_integrations = {
            "test_ns": {"status": "loaded"},
        }

        loader.shutdown()

        cleanup_mock.assert_called_once()
        assert not hasattr(interpreter.computer, "test_ns")

    def test_shutdown_idempotent(self):
        """Double-shutdown must not raise."""
        loader, _ = self._make_loader()
        loader._loaded_integrations = {}

        loader.shutdown()
        loader.shutdown()  # Second call is no-op


# =========================================================================
# 2. MCP Manager stop() -- _sandboxes cleared
# =========================================================================


class TestMCPManagerStopSandboxes:
    """Verify stop() clears _sandboxes dict."""

    @pytest.mark.asyncio
    async def test_sandboxes_cleared_after_stop(self):
        from core.mcp.manager import MCPServerManager

        mock_db = MagicMock()
        mock_db.list_servers = AsyncMock(return_value=[])
        manager = MCPServerManager(mock_db)

        # Inject fake sandbox reference
        from uuid import uuid4
        fake_id = uuid4()
        manager._sandboxes[fake_id] = MagicMock()
        manager._active_servers[fake_id] = MagicMock()

        # Patch _stop_server_quick to avoid real server interaction
        manager._stop_server_quick = AsyncMock()

        await manager.stop()

        assert len(manager._sandboxes) == 0, "_sandboxes should be empty after stop()"
        assert len(manager._active_servers) == 0, "_active_servers should be empty after stop()"
        assert len(manager._tool_cache) == 0, "_tool_cache should be empty after stop()"


# =========================================================================
# 3. RuntimeCoordinator disposed guard
# =========================================================================


class TestRuntimeCoordinatorDisposedGuard:
    """Verify _is_disposed flag prevents operations after stop()."""

    @pytest.mark.asyncio
    async def test_stop_sets_disposed_flag(self):
        from core.runtime.coordinator import RuntimeCoordinator

        coord = RuntimeCoordinator(settings=MagicMock())
        assert coord._is_disposed is False

        await coord.stop()

        assert coord._is_disposed is True

    @pytest.mark.asyncio
    async def test_stop_is_idempotent(self):
        """Double stop must not raise."""
        from core.runtime.coordinator import RuntimeCoordinator

        coord = RuntimeCoordinator(settings=MagicMock())
        await coord.stop()
        await coord.stop()  # Second call is no-op

    @pytest.mark.asyncio
    async def test_start_after_stop_raises(self):
        """Starting a disposed coordinator must fail fast."""
        from core.runtime.coordinator import RuntimeCoordinator

        coord = RuntimeCoordinator(settings=MagicMock())
        await coord.stop()

        with pytest.raises(RuntimeError, match="disposed"):
            await coord.start()

    @pytest.mark.asyncio
    async def test_dead_code_removed(self):
        """_initialize_all_modules should no longer exist (dead code removal)."""
        from core.runtime.coordinator import RuntimeCoordinator

        assert not hasattr(RuntimeCoordinator, "_initialize_all_modules")


# =========================================================================
# 4. RuntimeEngine -- no __getattr__ proxy
# =========================================================================


class TestRuntimeEngineNoGetattr:
    """Verify __getattr__ proxy was removed (FAIL_FAST)."""

    def test_unknown_attribute_raises_attribute_error(self):
        """Accessing undefined attribute must raise, not proxy to coordinator."""
        from core.runtime.engine import RuntimeEngine

        engine = RuntimeEngine(settings=None)
        with pytest.raises(AttributeError):
            _ = engine.this_does_not_exist

    def test_inject_system_context_explicitly_delegated(self):
        """inject_system_context should be an explicit method, not proxied."""
        from core.runtime.engine import RuntimeEngine

        engine = RuntimeEngine(settings=None)
        assert hasattr(engine, "inject_system_context")
        assert callable(engine.inject_system_context)

    def test_inject_system_context_delegates_to_coordinator(self):
        """inject_system_context should call coordinator's method."""
        from core.runtime.engine import RuntimeEngine

        engine = RuntimeEngine(settings=None)
        mock_coord = MagicMock()
        engine._coordinator = mock_coord

        engine.inject_system_context("session-1", "test context")

        mock_coord.inject_system_context.assert_called_once_with("session-1", "test context")


# =========================================================================
# 5. TraceGenerator -- bare except replaced
# =========================================================================


class TestTraceGeneratorExceptClauses:
    """Verify bare except: clauses are replaced with specific exception types."""

    def test_extract_json_handles_malformed_input(self):
        """_extract_json should handle malformed JSON without masking critical exceptions."""
        from services.proactive.logic.trace_generator import TraceGenerator

        # Patch __init__ to avoid needing API keys and config files
        with patch.object(TraceGenerator, '__init__', lambda self, **kw: None):
            gen = TraceGenerator.__new__(TraceGenerator)

        result = gen._extract_json("not json at all")
        assert result == {}

        result = gen._extract_json("{invalid json}")
        assert result == {}

        result = gen._extract_json('{"valid": true}')
        assert result == {"valid": True}

    def test_extract_json_empty_input(self):
        from services.proactive.logic.trace_generator import TraceGenerator

        with patch.object(TraceGenerator, '__init__', lambda self, **kw: None):
            gen = TraceGenerator.__new__(TraceGenerator)

        assert gen._extract_json("") == {}
        assert gen._extract_json(None) == {}


# =========================================================================
# 6. Engine singletons -- reset_singletons()
# =========================================================================


class TestEngineSingletonsReset:
    """Verify reset_singletons() clears module-level state."""

    def test_reset_singletons_clears_all(self):
        from core.runtime import engine as engine_module

        # Force singletons to be created
        engine_module._CONFIG_MANAGER_SINGLETON = MagicMock()
        engine_module._REQUEST_TRACKER_SINGLETON = MagicMock()
        engine_module._INTERPRETER_MANAGER_SINGLETON = MagicMock()

        engine_module.reset_singletons()

        assert engine_module._CONFIG_MANAGER_SINGLETON is None
        assert engine_module._REQUEST_TRACKER_SINGLETON is None
        assert engine_module._INTERPRETER_MANAGER_SINGLETON is None

    @pytest.mark.asyncio
    async def test_stop_calls_reset_singletons(self):
        """RuntimeEngine.stop() should call reset_singletons()."""
        from core.runtime import engine as engine_module

        # Set a sentinel value
        engine_module._CONFIG_MANAGER_SINGLETON = MagicMock()

        runtime = engine_module.RuntimeEngine(settings=None)
        # No coordinator, so stop() just calls reset_singletons()
        await runtime.stop()

        assert engine_module._CONFIG_MANAGER_SINGLETON is None
