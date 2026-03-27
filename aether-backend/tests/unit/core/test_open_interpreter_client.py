"""
Tests for core.integrations.providers.open_interpreter.client

Coverage target: 100% of client.py (167 lines, 0 existing tests).

Mock boundaries:
- interpreter module imports → sys.modules patches (OI not installed in test env)
- os.getenv → env var control for external server / vendored mode
- sys.path → mutation tracking
- Path.exists() → filesystem checks for vendor path

Real logic under test:
- Import path registration with env var gating
- External server mode fallback on ImportError
- Interpreter instance creation guarding
- Profile application delegation
"""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

from core.integrations.providers.open_interpreter.client import OpenInterpreterClient


# ---------------------------------------------------------------------------
# __init__ and is_initialized
# ---------------------------------------------------------------------------

class TestOpenInterpreterClientInit:

    def test_initial_state(self):
        c = OpenInterpreterClient()
        assert c._AsyncInterpreter is None
        assert c._apply_profile_func is None
        assert c._initialized is False
        assert c._oi_path is None
        assert c.is_initialized is False


# ---------------------------------------------------------------------------
# _register_package_path
# ---------------------------------------------------------------------------

class TestRegisterPackagePath:

    @patch.dict(os.environ, {"INTERPRETER_ALLOW_VENDORED_RUNTIME": ""}, clear=False)
    def test_no_vendored_mode_returns_early(self):
        """No sys.path modification when vendored mode disabled."""
        c = OpenInterpreterClient()
        original_path = sys.path.copy()
        c._register_package_path()
        assert sys.path == original_path

    @patch.dict(os.environ, {
        "INTERPRETER_ALLOW_VENDORED_RUNTIME": "1",
        "INTERPRETER_VENDOR_PATH": "",
    }, clear=False)
    def test_vendored_mode_empty_path_raises(self):
        c = OpenInterpreterClient()
        with pytest.raises(RuntimeError, match="INTERPRETER_VENDOR_PATH is empty"):
            c._register_package_path()

    @patch.dict(os.environ, {
        "INTERPRETER_ALLOW_VENDORED_RUNTIME": "true",
        "INTERPRETER_VENDOR_PATH": "/nonexistent/path/to/oi",
    }, clear=False)
    def test_vendored_mode_missing_path_raises(self):
        c = OpenInterpreterClient()
        with pytest.raises(RuntimeError, match="does not exist"):
            c._register_package_path()

    @patch.dict(os.environ, {
        "INTERPRETER_ALLOW_VENDORED_RUNTIME": "yes",
    }, clear=False)
    def test_vendored_mode_valid_path(self, tmp_path):
        oi_dir = tmp_path / "open-interpreter"
        oi_dir.mkdir()
        os.environ["INTERPRETER_VENDOR_PATH"] = str(oi_dir)

        c = OpenInterpreterClient()
        c._register_package_path()

        assert str(oi_dir) in sys.path
        assert os.environ.get("OPEN_INTERPRETER_PATH") == str(oi_dir)
        assert c._oi_path == oi_dir

        # Cleanup
        sys.path.remove(str(oi_dir))

    @patch.dict(os.environ, {
        "INTERPRETER_ALLOW_VENDORED_RUNTIME": "1",
    }, clear=False)
    def test_vendored_mode_no_duplicate_path(self, tmp_path):
        """If path already in sys.path, don't insert again."""
        oi_dir = tmp_path / "open-interpreter"
        oi_dir.mkdir()
        os.environ["INTERPRETER_VENDOR_PATH"] = str(oi_dir)

        # Pre-add to sys.path
        sys.path.insert(0, str(oi_dir))
        count_before = sys.path.count(str(oi_dir))

        c = OpenInterpreterClient()
        c._register_package_path()

        count_after = sys.path.count(str(oi_dir))
        assert count_after == count_before  # no duplicate

        # Cleanup
        sys.path.remove(str(oi_dir))


# ---------------------------------------------------------------------------
# _get_path_candidates
# ---------------------------------------------------------------------------

class TestGetPathCandidates:

    def test_returns_empty_list(self):
        c = OpenInterpreterClient()
        assert c._get_path_candidates() == []


# ---------------------------------------------------------------------------
# initialize
# ---------------------------------------------------------------------------

class TestInitialize:

    @pytest.mark.asyncio
    async def test_already_initialized_returns_early(self):
        c = OpenInterpreterClient()
        c._initialized = True
        await c.initialize()  # should not raise or do anything
        assert c.is_initialized is True

    @pytest.mark.asyncio
    @patch.dict(os.environ, {"INTERPRETER_EXTERNAL_SERVER_ENABLED": ""}, clear=False)
    async def test_local_import_success(self):
        """Successful import of AsyncInterpreter and profiles."""
        c = OpenInterpreterClient()

        mock_ai = MagicMock()
        mock_profile = MagicMock()

        with patch.object(c, "_register_package_path"):
            with patch.dict("sys.modules", {
                "interpreter": MagicMock(AsyncInterpreter=mock_ai),
                "interpreter.terminal_interface": MagicMock(),
                "interpreter.terminal_interface.profiles": MagicMock(),
                "interpreter.terminal_interface.profiles.profiles": MagicMock(profile=mock_profile),
            }):
                await c.initialize()

        assert c.is_initialized is True
        assert c._AsyncInterpreter is mock_ai
        assert c._apply_profile_func is mock_profile

    @pytest.mark.asyncio
    @patch.dict(os.environ, {"INTERPRETER_EXTERNAL_SERVER_ENABLED": "1"}, clear=False)
    async def test_external_mode_fallback_on_import_error(self):
        """ImportError with external server mode → initialized for proxy use."""
        c = OpenInterpreterClient()

        with patch.object(c, "_register_package_path"):
            # Simulate import failure by making the module import raise
            with patch("builtins.__import__", side_effect=ImportError("no interpreter")):
                await c.initialize()

        assert c.is_initialized is True
        assert c._AsyncInterpreter is None  # no local interpreter

    @pytest.mark.asyncio
    @patch.dict(os.environ, {"INTERPRETER_EXTERNAL_SERVER_ENABLED": ""}, clear=False)
    async def test_local_mode_import_error_raises(self):
        """ImportError without external server mode → RuntimeError."""
        c = OpenInterpreterClient()

        with patch.object(c, "_register_package_path"):
            with patch("builtins.__import__", side_effect=ImportError("no interpreter")):
                with pytest.raises(RuntimeError, match="initialization failed"):
                    await c.initialize()

    @pytest.mark.asyncio
    @patch.dict(os.environ, {"INTERPRETER_EXTERNAL_SERVER_ENABLED": "true"}, clear=False)
    async def test_external_mode_generic_error_fallback(self):
        """Generic Exception with external mode → initialized for proxy use."""
        c = OpenInterpreterClient()

        with patch.object(c, "_register_package_path", side_effect=OSError("disk error")):
            await c.initialize()

        assert c.is_initialized is True

    @pytest.mark.asyncio
    @patch.dict(os.environ, {"INTERPRETER_EXTERNAL_SERVER_ENABLED": ""}, clear=False)
    async def test_local_mode_generic_error_raises(self):
        """Generic Exception without external mode → RuntimeError."""
        c = OpenInterpreterClient()

        with patch.object(c, "_register_package_path", side_effect=OSError("disk error")):
            with pytest.raises(RuntimeError, match="initialization failed"):
                await c.initialize()


# ---------------------------------------------------------------------------
# create_interpreter
# ---------------------------------------------------------------------------

class TestCreateInterpreter:

    def test_not_initialized_raises(self):
        c = OpenInterpreterClient()
        with pytest.raises(RuntimeError, match="not initialized"):
            c.create_interpreter()

    def test_initialized_but_no_class_raises(self):
        """Initialized (proxy mode) but no AsyncInterpreter class."""
        c = OpenInterpreterClient()
        c._initialized = True
        c._AsyncInterpreter = None
        with pytest.raises(RuntimeError, match="not initialized"):
            c.create_interpreter()

    def test_success(self):
        c = OpenInterpreterClient()
        c._initialized = True
        mock_cls = MagicMock()
        mock_instance = MagicMock()
        mock_cls.return_value = mock_instance
        c._AsyncInterpreter = mock_cls

        result = c.create_interpreter()

        assert result is mock_instance
        mock_cls.assert_called_once()


# ---------------------------------------------------------------------------
# apply_profile
# ---------------------------------------------------------------------------

class TestApplyProfile:

    def test_no_func_available_returns(self):
        c = OpenInterpreterClient()
        c._apply_profile_func = None
        mock_interp = MagicMock()
        c.apply_profile(mock_interp, "default")  # should not raise

    def test_success(self):
        c = OpenInterpreterClient()
        mock_func = MagicMock()
        c._apply_profile_func = mock_func
        mock_interp = MagicMock()

        c.apply_profile(mock_interp, "custom_profile")

        mock_func.assert_called_once_with(mock_interp, "custom_profile")

    def test_error_propagates(self):
        c = OpenInterpreterClient()
        mock_func = MagicMock(side_effect=ValueError("bad profile"))
        c._apply_profile_func = mock_func

        with pytest.raises(ValueError, match="bad profile"):
            c.apply_profile(MagicMock(), "broken")
