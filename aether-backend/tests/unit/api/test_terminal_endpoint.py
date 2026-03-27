"""
Unit tests for Terminal endpoint (GET /v1/launch_terminal).

Single endpoint launching system terminal application.
Tests cover all platform branches (macOS, Windows, Linux), fallback chains,
security gate (allow_local_os_tools), and error handling.

No bugs found during audit.

CI: pytest tests/unit/api/test_terminal_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import MagicMock, patch


class TestLaunchTerminal:
    """GET /v1/launch_terminal — all platform/security branches."""

    # ---- macOS ----

    @pytest.mark.asyncio
    async def test_macos_iterm(self, client):
        """macOS: iTerm2 launch succeeds → returns iTerm2 terminal type."""
        with patch("core.system.process_gateway.platform.system", return_value="Darwin"):
            with patch("core.system.process_gateway.subprocess.Popen") as mock_popen:
                resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["terminal"] == "iTerm2"
        assert body["platform"] == "Darwin"
        mock_popen.assert_called_once_with(["open", "-a", "iTerm"], start_new_session=True)

    @pytest.mark.asyncio
    async def test_macos_fallback_terminal_app(self, client):
        """macOS: iTerm2 not found → falls back to Terminal.app."""
        with patch("core.system.process_gateway.platform.system", return_value="Darwin"):
            with patch("core.system.process_gateway.subprocess.Popen") as mock_popen:
                mock_popen.side_effect = [OSError("iTerm not found"), MagicMock()]
                resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 200
        body = resp.json()
        assert body["terminal"] == "Terminal.app"

    @pytest.mark.asyncio
    async def test_macos_both_fail_501(self, client):
        """macOS: both iTerm2 and Terminal.app fail → 501."""
        with patch("core.system.process_gateway.platform.system", return_value="Darwin"):
            with patch("core.system.process_gateway.subprocess.Popen") as mock_popen:
                mock_popen.side_effect = [
                    OSError("iTerm not found"),
                    OSError("Terminal.app not found"),
                ]
                resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 501
        assert "failed on Darwin" in resp.json()["detail"]

    # ---- Windows ----

    @pytest.mark.asyncio
    async def test_windows_wt(self, client):
        """Windows: wt.exe launch succeeds."""
        with patch("core.system.process_gateway.platform.system", return_value="Windows"):
            with patch("core.system.process_gateway.subprocess.Popen"):
                resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 200
        body = resp.json()
        assert body["terminal"] == "Windows Terminal"
        assert body["platform"] == "Windows"

    @pytest.mark.asyncio
    async def test_windows_fallback_cmd(self, client):
        """Windows: wt.exe fails → falls back to cmd.exe."""
        with patch("core.system.process_gateway.platform.system", return_value="Windows"):
            with patch("core.system.process_gateway.subprocess.Popen") as mock_popen:
                mock_popen.side_effect = [OSError("wt not found"), MagicMock()]
                resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 200
        body = resp.json()
        assert body["terminal"] == "cmd.exe"

    @pytest.mark.asyncio
    async def test_windows_both_fail_501(self, client):
        """Windows: both wt.exe and cmd.exe fail → 501."""
        with patch("core.system.process_gateway.platform.system", return_value="Windows"):
            with patch("core.system.process_gateway.subprocess.Popen") as mock_popen:
                mock_popen.side_effect = [
                    OSError("wt not found"),
                    FileNotFoundError("cmd not found"),
                ]
                resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 501
        assert "failed on Windows" in resp.json()["detail"]

    # ---- Linux ----

    @pytest.mark.asyncio
    async def test_linux_gnome(self, client):
        """Linux: gnome-terminal found first."""
        with patch("core.system.process_gateway.platform.system", return_value="Linux"):
            with patch("core.system.process_gateway.subprocess.Popen"):
                resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 200
        body = resp.json()
        assert body["terminal"] == "GNOME Terminal"
        assert body["platform"] == "Linux"

    @pytest.mark.asyncio
    async def test_linux_fallback_chain(self, client):
        """Linux: gnome-terminal fails, konsole succeeds."""
        with patch("core.system.process_gateway.platform.system", return_value="Linux"):
            with patch("core.system.process_gateway.subprocess.Popen") as mock_popen:
                mock_popen.side_effect = [
                    FileNotFoundError("gnome-terminal not found"),
                    MagicMock(),  # konsole succeeds
                ]
                resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 200
        body = resp.json()
        assert body["terminal"] == "Konsole"

    @pytest.mark.asyncio
    async def test_linux_no_emulator_found(self, client):
        """Linux: all terminal emulators missing → 501."""
        with patch("core.system.process_gateway.platform.system", return_value="Linux"):
            with patch("core.system.process_gateway.subprocess.Popen", side_effect=FileNotFoundError):
                resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 501
        assert "failed on Linux" in resp.json()["detail"]

    # ---- Unsupported Platform ----

    @pytest.mark.asyncio
    async def test_unsupported_platform_501(self, client):
        """FreeBSD or other → 501."""
        with patch("core.system.process_gateway.platform.system", return_value="FreeBSD"):
            resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 501
        assert "FreeBSD" in resp.json()["detail"]

    # ---- Security ----

    @pytest.mark.asyncio
    async def test_security_disabled_403(self, client, app):
        """settings.security.allow_local_os_tools = False → 403."""
        from api.dependencies import get_settings as _gs
        real = _gs()
        mock_settings = MagicMock(wraps=real)
        mock_settings.security.allow_local_os_tools = False
        app.dependency_overrides[_gs] = lambda: mock_settings
        try:
            resp = await client.get("/v1/launch_terminal")
            assert resp.status_code == 403
            assert "disabled" in resp.json()["detail"].lower()
        finally:
            app.dependency_overrides.pop(_gs, None)

    # ---- Generic Error ----

    @pytest.mark.asyncio
    async def test_generic_exception_returns_501(self, client):
        """Unexpected subprocess error → 501 (mapped to success=False)."""
        with patch("core.system.process_gateway.platform.system", return_value="Darwin"):
            with patch(
                "core.system.process_gateway.subprocess.Popen",
                side_effect=RuntimeError("proc pool exhausted"),
            ):
                resp = await client.get("/v1/launch_terminal")
        assert resp.status_code == 501
        assert "failed on Darwin" in resp.json()["detail"]
