"""
Unit Tests: RuntimeSettingsApplicator

Application service tests -- mocked runtime and repository.
Tests settings resolution, application to runtime, and FAIL_FAST behavior.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from ws.application.runtime_settings_applicator import RuntimeSettingsApplicator


@pytest.fixture
def applicator():
    """RuntimeSettingsApplicator instance."""
    return RuntimeSettingsApplicator()


class TestSkipConditions:
    """Tests for early-return conditions."""

    @pytest.mark.asyncio
    async def test_skips_when_no_chat_id(self, applicator):
        """Should skip silently when chat_id is None."""
        runtime = SimpleNamespace(settings=None)
        repo = MagicMock()

        result = await applicator.apply(
            runtime=runtime,
            chat_repository=repo,
            chat_id=None,
        )

        assert result is None
        # Runtime was NOT mutated — settings stays at original value
        assert runtime.settings is None

    @pytest.mark.asyncio
    async def test_skips_when_no_chat_repository(self, applicator):
        """Should skip silently when chat_repository is None."""
        runtime = SimpleNamespace(settings=None)

        result = await applicator.apply(
            runtime=runtime,
            chat_repository=None,
            chat_id=str(uuid4()),
        )

        assert result is None
        assert runtime.settings is None

    @pytest.mark.asyncio
    async def test_skips_when_no_gateway(self, applicator):
        """Should skip silently when repository has no _gateway attribute."""
        runtime = SimpleNamespace(settings=None)
        repo = MagicMock(spec=[])  # No _gateway attribute

        result = await applicator.apply(
            runtime=runtime,
            chat_repository=repo,
            chat_id=str(uuid4()),
        )

        assert result is None
        assert runtime.settings is None


class TestSettingsApplication:
    """Tests for settings resolution and application."""

    @pytest.mark.asyncio
    async def test_applies_settings_to_runtime_facade(self, applicator):
        """Should set runtime.settings to the resolved effective settings."""
        runtime = MagicMock()
        runtime.settings = None
        repo = MagicMock()
        repo._gateway = MagicMock()

        mock_settings = {"model": "gpt-4o", "capabilities": ["code_execution"]}

        mock_svc = MagicMock()
        mock_svc.get_runtime_settings = AsyncMock(return_value=mock_settings)
        with patch(
            "application.settings.get_runtime_settings_service",
            return_value=mock_svc,
        ):
            await applicator.apply(
                runtime=runtime,
                chat_repository=repo,
                chat_id=str(uuid4()),
            )

        assert runtime.settings == mock_settings

    @pytest.mark.asyncio
    async def test_applies_settings_to_interpreter_manager(self, applicator):
        """Should call interpreter_manager.apply_settings_async with resolved settings."""
        mock_settings = {"model": "gpt-4o"}
        manager = MagicMock()
        manager.apply_settings_async = AsyncMock()
        runtime = MagicMock()
        runtime.settings = None
        runtime._interpreter_manager = manager
        repo = MagicMock()
        repo._gateway = MagicMock()

        mock_svc = MagicMock()
        mock_svc.get_runtime_settings = AsyncMock(return_value=mock_settings)
        with patch(
            "application.settings.get_runtime_settings_service",
            return_value=mock_svc,
        ):
            await applicator.apply(
                runtime=runtime,
                chat_repository=repo,
                chat_id=str(uuid4()),
            )

        manager.apply_settings_async.assert_awaited_once_with(
            mock_settings, init=False
        )


class TestFailFast:
    """Tests for FAIL_FAST RuntimeError on settings resolution failure."""

    @pytest.mark.asyncio
    async def test_raises_runtime_error_on_import_error(self, applicator):
        """ImportError during settings resolution should raise RuntimeError."""
        runtime = MagicMock()
        repo = MagicMock()
        repo._gateway = MagicMock()

        with patch.dict("sys.modules", {"application.settings.runtime_settings_service": None}):
            with pytest.raises(RuntimeError, match="Failed to resolve/apply runtime settings"):
                await applicator.apply(
                    runtime=runtime,
                    chat_repository=repo,
                    chat_id=str(uuid4()),
                )

    @pytest.mark.asyncio
    async def test_raises_runtime_error_on_connection_error(self, applicator):
        """ConnectionError during settings resolution should raise RuntimeError."""
        runtime = MagicMock()
        repo = MagicMock()
        repo._gateway = MagicMock()

        mock_svc = MagicMock()
        mock_svc.get_runtime_settings = AsyncMock(side_effect=ConnectionError("DB unreachable"))
        with patch(
            "application.settings.get_runtime_settings_service",
            return_value=mock_svc,
        ):
            with pytest.raises(RuntimeError, match="Failed to resolve/apply runtime settings"):
                await applicator.apply(
                    runtime=runtime,
                    chat_repository=repo,
                    chat_id=str(uuid4()),
                )


class TestSettingsAssignmentError:
    """Tests for exception handling when setting runtime.settings fails."""

    @pytest.mark.asyncio
    async def test_readonly_settings_property_handled_gracefully(self, applicator):
        """
        Line 77: AttributeError when runtime.settings is read-only property.

        The except (AttributeError, TypeError) handler must suppress the error
        and allow the method to continue (apply to interpreter manager, etc.).
        """
        mock_settings = {"model": "gpt-4o"}

        # Create runtime with read-only property (assignment raises AttributeError)
        class ReadOnlyRuntime:
            @property
            def settings(self):
                return None
            # No setter → assignment raises AttributeError

        runtime = ReadOnlyRuntime()
        runtime._interpreter_manager = None  # No manager
        repo = MagicMock()
        repo._gateway = MagicMock()

        mock_svc = MagicMock()
        mock_svc.get_runtime_settings = AsyncMock(return_value=mock_settings)
        with patch(
            "application.settings.get_runtime_settings_service",
            return_value=mock_svc,
        ):
            # Should NOT raise — the AttributeError is caught at line 77
            result = await applicator.apply(
                runtime=runtime,
                chat_repository=repo,
                chat_id=str(uuid4()),
            )

        assert result is None


class TestBroadExceptionHandling:
    """Adversarial tests for broadened except clauses in runtime_settings_applicator."""

    @pytest.mark.asyncio
    async def test_interpreter_manager_runtime_error_suppressed(self, applicator):
        """Bug fix: RuntimeError from manager.apply_settings_async was NOT caught
        by the old (AttributeError, TypeError) except clause. Now caught by except Exception."""
        mock_settings = {"model": "gpt-4o"}
        manager = MagicMock()
        manager.apply_settings_async = AsyncMock(side_effect=RuntimeError("manager crash"))
        runtime = MagicMock()
        runtime.settings = None
        runtime._interpreter_manager = manager
        repo = MagicMock()
        repo._gateway = MagicMock()

        mock_svc = MagicMock()
        mock_svc.get_runtime_settings = AsyncMock(return_value=mock_settings)
        with patch(
            "application.settings.get_runtime_settings_service",
            return_value=mock_svc,
        ):
            # Should NOT raise — RuntimeError is now caught by broadened except
            result = await applicator.apply(
                runtime=runtime,
                chat_repository=repo,
                chat_id=str(uuid4()),
            )

        assert result is None

    @pytest.mark.asyncio
    async def test_interpreter_manager_timeout_error_suppressed(self, applicator):
        """TimeoutError from manager.apply_settings_async is caught."""
        mock_settings = {"model": "gpt-4o"}
        manager = MagicMock()
        manager.apply_settings_async = AsyncMock(side_effect=TimeoutError("settings timeout"))
        runtime = MagicMock()
        runtime.settings = None
        runtime._interpreter_manager = manager
        repo = MagicMock()
        repo._gateway = MagicMock()

        mock_svc = MagicMock()
        mock_svc.get_runtime_settings = AsyncMock(return_value=mock_settings)
        with patch(
            "application.settings.get_runtime_settings_service",
            return_value=mock_svc,
        ):
            result = await applicator.apply(
                runtime=runtime,
                chat_repository=repo,
                chat_id=str(uuid4()),
            )

        assert result is None

    @pytest.mark.asyncio
    async def test_outer_except_catches_type_error(self, applicator):
        """Outer except now catches TypeError (previously missed)."""
        runtime = MagicMock()
        repo = MagicMock()
        repo._gateway = MagicMock()

        mock_svc = MagicMock()
        mock_svc.get_runtime_settings = AsyncMock(side_effect=TypeError("unexpected type in settings"))
        with patch(
            "application.settings.get_runtime_settings_service",
            return_value=mock_svc,
        ):
            with pytest.raises(RuntimeError, match="Failed to resolve/apply runtime settings"):
                await applicator.apply(
                    runtime=runtime,
                    chat_repository=repo,
                    chat_id=str(uuid4()),
                )

    @pytest.mark.asyncio
    async def test_outer_except_catches_attribute_error(self, applicator):
        """Outer except now catches AttributeError (previously missed)."""
        runtime = MagicMock()
        repo = MagicMock()
        repo._gateway = MagicMock()

        mock_svc = MagicMock()
        mock_svc.get_runtime_settings = AsyncMock(side_effect=AttributeError("settings has no attribute"))
        with patch(
            "application.settings.get_runtime_settings_service",
            return_value=mock_svc,
        ):
            with pytest.raises(RuntimeError, match="Failed to resolve/apply runtime settings"):
                await applicator.apply(
                    runtime=runtime,
                    chat_repository=repo,
                    chat_id=str(uuid4()),
                )
