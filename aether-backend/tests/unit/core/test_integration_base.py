"""
Unit Tests: Base Integration Classes (core/integrations/framework/base.py)

Covers IntegrationStatus/Type enums, dataclasses, BaseIntegration lifecycle,
ServiceIntegration HTTP health check, LibraryIntegration, and helpers.

Mock boundaries:
- httpx.Client → mocked for ServiceIntegration health check
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from core.integrations.framework.base import (
    IntegrationStatus,
    IntegrationType,
    IntegrationMetadata,
    IntegrationHealth,
    IntegrationProtocol,
    BaseIntegration,
    ServiceIntegration,
    LibraryIntegration,
)


# ─── Minimal subclass (doesn't override _enrich_metadata) ────────────────────


class MinimalIntegration(BaseIntegration):
    """Minimal implementation — uses default _enrich_metadata."""

    def _do_load(self, computer):
        return True

    def _do_health_check(self):
        return IntegrationHealth(healthy=True)


# ─── Concrete subclass for testing BaseIntegration ──────────────────────────


class StubIntegration(BaseIntegration):
    """Concrete implementation for testing."""

    def __init__(self, *, load_result=True, health=None, cleanup_error=None, enrich=None, name="stub"):
        super().__init__(name=name, version="0.1.0", integration_type=IntegrationType.LIBRARY)
        self._load_result = load_result
        self._health = health or IntegrationHealth(healthy=True, message="ok")
        self._cleanup_error = cleanup_error
        self._enrich = enrich

    def _do_load(self, computer):
        return self._load_result

    def _do_health_check(self):
        return self._health

    def _do_cleanup(self):
        if self._cleanup_error:
            raise self._cleanup_error

    def _enrich_metadata(self, metadata):
        if self._enrich:
            return self._enrich(metadata)
        return metadata


class RaisingLoadIntegration(BaseIntegration):
    """Raises during _do_load."""

    def __init__(self):
        super().__init__(name="raiser")

    def _do_load(self, computer):
        raise RuntimeError("load exploded")

    def _do_health_check(self):
        return IntegrationHealth(healthy=True)


class RaisingHealthIntegration(BaseIntegration):
    """Raises during _do_health_check."""

    def __init__(self):
        super().__init__(name="health_raiser")

    def _do_load(self, computer):
        return True

    def _do_health_check(self):
        raise ValueError("health exploded")


class RaisingMetadataIntegration(BaseIntegration):
    """Raises during _enrich_metadata."""

    def __init__(self):
        super().__init__(name="meta_raiser")

    def _do_load(self, computer):
        return True

    def _do_health_check(self):
        return IntegrationHealth(healthy=True)

    def _enrich_metadata(self, metadata):
        raise TypeError("enrich exploded")


# ─── Enums ──────────────────────────────────────────────────────────────────


class TestEnums:
    def test_integration_status_values(self):
        assert IntegrationStatus.NOT_LOADED.value == "not_loaded"
        assert IntegrationStatus.LOADED.value == "loaded"
        assert IntegrationStatus.FAILED.value == "failed"
        assert IntegrationStatus.DISABLED.value == "disabled"

    def test_integration_type_values(self):
        assert IntegrationType.SERVICE.value == "service"
        assert IntegrationType.LIBRARY.value == "library"
        assert IntegrationType.BRIDGE.value == "bridge"
        assert IntegrationType.BUILTIN.value == "builtin"
        assert IntegrationType.DYNAMIC.value == "dynamic"


# ─── Data Classes ───────────────────────────────────────────────────────────


class TestDataClasses:
    def test_integration_metadata_defaults(self):
        m = IntegrationMetadata(name="test")
        assert m.name == "test"
        assert m.version == "1.0.0"
        assert m.tool_count == 0
        assert m.requires_service is False
        assert m.dependencies == []

    def test_integration_health_defaults(self):
        h = IntegrationHealth(healthy=True)
        assert h.healthy is True
        assert h.message == ""
        assert h.details == {}


# ─── BaseIntegration.__init__ ───────────────────────────────────────────────


class TestBaseInit:
    def test_initial_state(self):
        i = StubIntegration()
        assert i.status == IntegrationStatus.NOT_LOADED
        assert i._computer is None
        assert i._tools == []
        assert i._load_error is None


# ─── BaseIntegration.load ───────────────────────────────────────────────────


class TestLoad:
    def test_success(self):
        i = StubIntegration()
        computer = MagicMock()
        assert i.load(computer) is True
        assert i.status == IntegrationStatus.LOADED
        assert i._computer is computer

    def test_already_loaded(self):
        i = StubIntegration()
        i.load(MagicMock())
        assert i.load(MagicMock()) is True  # Returns True without re-loading

    def test_load_returns_false(self):
        i = StubIntegration(load_result=False)
        assert i.load(MagicMock()) is False
        assert i.status == IntegrationStatus.FAILED
        assert i._load_error == "Load method returned False"

    def test_computer_none(self):
        i = StubIntegration()
        assert i.load(None) is False
        assert i.status == IntegrationStatus.FAILED
        assert "None" in i._load_error

    def test_exception_during_load(self):
        i = RaisingLoadIntegration()
        assert i.load(MagicMock()) is False
        assert i.status == IntegrationStatus.FAILED
        assert "load exploded" in i._load_error


# ─── BaseIntegration.health_check ───────────────────────────────────────────


class TestHealthCheck:
    def test_not_loaded(self):
        i = StubIntegration()
        h = i.health_check()
        assert h.healthy is False
        assert "not loaded" in h.message

    def test_loaded(self):
        i = StubIntegration()
        i.load(MagicMock())
        h = i.health_check()
        assert h.healthy is True

    def test_exception_during_health(self):
        i = RaisingHealthIntegration()
        i.load(MagicMock())
        h = i.health_check()
        assert h.healthy is False
        assert "ValueError" in h.message


# ─── BaseIntegration.get_metadata ───────────────────────────────────────────


class TestGetMetadata:
    def test_basic(self):
        i = StubIntegration()
        m = i.get_metadata()
        assert m.name == "stub"
        assert m.version == "0.1.0"

    def test_with_tools(self):
        i = StubIntegration()
        i._tools = ["a", "b"]
        m = i.get_metadata()
        assert m.tool_count == 2

    def test_exception_during_enrich(self):
        i = RaisingMetadataIntegration()
        m = i.get_metadata()
        assert "TypeError" in m.description


# ─── BaseIntegration.get_tools ──────────────────────────────────────────────


class TestGetTools:
    def test_returns_copy(self):
        i = StubIntegration()
        i._tools = ["a"]
        tools = i.get_tools()
        assert tools == ["a"]
        tools.append("b")
        assert i._tools == ["a"]  # Original unchanged


# ─── BaseIntegration.cleanup ────────────────────────────────────────────────


class TestCleanup:
    def test_success(self):
        i = StubIntegration()
        i.cleanup()  # Should not raise

    def test_exception(self):
        i = StubIntegration(cleanup_error=RuntimeError("clean fail"))
        i.cleanup()  # Should not raise, just log


# ─── BaseIntegration.is_loaded / get_load_error ─────────────────────────────


class TestStateHelpers:
    def test_is_loaded(self):
        i = StubIntegration()
        assert i.is_loaded() is False
        i.load(MagicMock())
        assert i.is_loaded() is True

    def test_get_load_error(self):
        i = StubIntegration(load_result=False)
        i.load(MagicMock())
        assert i.get_load_error() is not None


# ─── _register_tool / _register_tools ───────────────────────────────────────


class TestRegisterTool:
    def test_register_single(self):
        i = StubIntegration()
        i._register_tool("tool_a")
        assert "tool_a" in i._tools

    def test_no_duplicates(self):
        i = StubIntegration()
        i._register_tool("tool_a")
        i._register_tool("tool_a")
        assert i._tools.count("tool_a") == 1

    def test_register_multiple(self):
        i = StubIntegration()
        i._register_tools(["a", "b", "c"])
        assert len(i._tools) == 3


# ─── _attach_function / _attach_namespace ───────────────────────────────────


class TestAttach:
    def test_attach_function(self):
        i = StubIntegration()
        computer = MagicMock()
        i.load(computer)
        func = lambda: "result"
        i._attach_function("my_tool", func)
        assert hasattr(computer, "my_tool")
        assert "my_tool" in i._tools

    def test_attach_function_no_computer(self):
        i = StubIntegration()
        with pytest.raises(RuntimeError, match="computer not initialized"):
            i._attach_function("tool", lambda: None)

    def test_attach_namespace(self):
        i = StubIntegration()
        computer = MagicMock()
        i.load(computer)
        ns = MagicMock()
        i._attach_namespace("browser", ns)
        assert hasattr(computer, "browser")

    def test_attach_namespace_no_computer(self):
        i = StubIntegration()
        with pytest.raises(RuntimeError, match="computer not initialized"):
            i._attach_namespace("browser", MagicMock())


# ─── _validate_dependencies ─────────────────────────────────────────────────


# ─── Adversarial / Contract / Lifecycle Tests ────────────────────────────────


class TestLoadContractViolations:
    """Tests that expose contract issues in the load lifecycle."""

    def test_load_twice_does_not_update_computer(self):
        """load() on LOADED integration returns True but does NOT update _computer.
        This is a documented design decision, not a bug — callers must check is_loaded()."""
        i = StubIntegration()
        computer1 = MagicMock()
        computer2 = MagicMock()
        i.load(computer1)
        i.load(computer2)
        assert i._computer is computer1  # NOT computer2

    def test_health_check_returns_correct_type(self):
        """health_check must ALWAYS return IntegrationHealth, never None or dict."""
        i = StubIntegration()
        h = i.health_check()
        assert isinstance(h, IntegrationHealth)

        i.load(MagicMock())
        h = i.health_check()
        assert isinstance(h, IntegrationHealth)

    def test_get_metadata_returns_correct_type(self):
        """get_metadata must ALWAYS return IntegrationMetadata."""
        i = RaisingMetadataIntegration()
        m = i.get_metadata()
        assert isinstance(m, IntegrationMetadata)

    def test_cleanup_idempotent(self):
        """cleanup() twice must not raise."""
        i = StubIntegration()
        i.load(MagicMock())
        i.cleanup()
        i.cleanup()

    def test_load_error_preserved_exactly(self):
        """The error message in get_load_error() must match the exception."""
        i = RaisingLoadIntegration()
        i.load(MagicMock())
        assert i.get_load_error() == "load exploded"

    def test_status_transitions(self):
        """Verify exact status transitions: NOT_LOADED → LOADING → LOADED."""
        i = StubIntegration()
        assert i.status == IntegrationStatus.NOT_LOADED

        states = []
        original_do_load = i._do_load

        def tracking_load(computer):
            states.append(i.status)
            return original_do_load(computer)

        i._do_load = tracking_load
        i.load(MagicMock())

        assert states == [IntegrationStatus.LOADING]
        assert i.status == IntegrationStatus.LOADED


class TestValidateDependencies:
    def test_available_dependency(self):
        i = StubIntegration()
        result = i._validate_dependencies(["os", "sys"])
        assert result["os"] is True
        assert result["sys"] is True

    def test_unavailable_dependency(self):
        i = StubIntegration()
        result = i._validate_dependencies(["nonexistent_module_xyz"])
        assert result["nonexistent_module_xyz"] is False


# ─── ServiceIntegration ─────────────────────────────────────────────────────


class ConcreteService(ServiceIntegration):
    """Concrete ServiceIntegration for testing."""

    def _do_load(self, computer):
        return True


class TestServiceIntegration:
    def test_init(self):
        s = ConcreteService("svc", "http://localhost:9000")
        assert s.service_url == "http://localhost:9000"
        assert s.health_check_url == "http://localhost:9000/health"
        assert s.integration_type == IntegrationType.SERVICE
        assert s.requires_service is True

    def test_custom_health_url(self):
        s = ConcreteService("svc", "http://localhost:9000", health_check_url="http://localhost:9000/ping")
        assert s.health_check_url == "http://localhost:9000/ping"

    def test_health_check_success(self):

        s = ConcreteService("svc", "http://localhost:9000")
        s.load(MagicMock())

        mock_resp = MagicMock()
        mock_resp.status_code = 200

        mock_client = MagicMock()
        mock_client.get.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch("httpx.Client", return_value=mock_client):
            h = s.health_check()

        assert h.healthy is True

    def test_health_check_non_200(self):
        s = ConcreteService("svc", "http://localhost:9000")
        s.load(MagicMock())

        mock_resp = MagicMock()
        mock_resp.status_code = 503

        mock_client = MagicMock()
        mock_client.get.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch("httpx.Client", return_value=mock_client):
            h = s.health_check()

        assert h.healthy is False

    def test_health_check_connection_error(self):
        import httpx

        s = ConcreteService("svc", "http://localhost:9000")
        s.load(MagicMock())

        mock_client = MagicMock()
        mock_client.get.side_effect = httpx.ConnectError("refused")
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch("httpx.Client", return_value=mock_client):
            h = s.health_check()

        assert h.healthy is False
        assert "ConnectError" in h.message


# ─── LibraryIntegration ─────────────────────────────────────────────────────


class ConcreteLibrary(LibraryIntegration):
    """Concrete LibraryIntegration for testing."""

    def _do_load(self, computer):
        return True

    def _do_health_check(self):
        return super()._do_health_check()


class TestLibraryIntegration:
    def test_init(self):
        lib = ConcreteLibrary("mylib")
        assert lib.integration_type == IntegrationType.LIBRARY
        assert lib.requires_service is False

    def test_health_loaded(self):
        lib = ConcreteLibrary("mylib")
        lib.load(MagicMock())
        h = lib.health_check()
        assert h.healthy is True
        assert "loaded" in h.message.lower()

    def test_health_not_loaded(self):
        lib = ConcreteLibrary("mylib")
        # Force status to LOADED then check with super directly
        h = lib._do_health_check()
        assert h.healthy is False
        assert "not loaded" in h.message.lower()


# ─── IntegrationProtocol stubs (lines 108, 112, 116, 120, 124) ──────────────


class TestProtocolStubs:
    """Exercise Protocol method stubs via unbound calls for coverage."""

    def test_load_stub(self):
        result = IntegrationProtocol.load(MagicMock(), MagicMock())
        assert result is None

    def test_health_check_stub(self):
        result = IntegrationProtocol.health_check(MagicMock())
        assert result is None

    def test_get_metadata_stub(self):
        result = IntegrationProtocol.get_metadata(MagicMock())
        assert result is None

    def test_get_tools_stub(self):
        result = IntegrationProtocol.get_tools(MagicMock())
        assert result is None

    def test_cleanup_stub(self):
        result = IntegrationProtocol.cleanup(MagicMock())
        assert result is None


# ─── Default _enrich_metadata (line 349) ─────────────────────────────────────


class TestDefaultEnrichMetadata:
    def test_default_enrich_returns_metadata_unchanged(self):
        """BaseIntegration._enrich_metadata returns metadata as-is (line 349)."""
        i = MinimalIntegration(name="minimal")
        m = i.get_metadata()
        assert isinstance(m, IntegrationMetadata)
        assert m.name == "minimal"
